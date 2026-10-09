import { emptyDimensions, unlocked } from "./engine";

/**
 * One prioritization system (KAN-17). The legacy residual-keyed priority board
 * (`priorities`, four bands with Critical) and the legacy roadmap (`roadmap`,
 * tactics accepted against a residual) are retired: bands are S8's
 * `priority_placements` and the forward plan is the S10 timeline.
 *
 * These statements carry what a person decided on the old surfaces into the
 * live ones, once per row, with an audit row for each:
 * - a locked legacy band on a live gap becomes that gap's validated band, unless
 *   the gap already has a placement (Critical folds into High, as the board did);
 * - a roadmap row that planned a tactic against a gap's residual becomes an
 *   unassessed mapping of that tactic to the gap, unless they are already mapped
 *   or a person rejected the pair.
 *
 * The legacy tables keep their rows; `carried_over_at` marks the ones already
 * processed, so the statements are safe on every bootstrap.
 */
export function legacyPlanCarryOverStatements(): string[] {
  const literal = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  const liveGap = "NOT g.retired AND g.status <> 'excluded' AND g.parked_at IS NULL";
  const at = "to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
  return [
    "ALTER TABLE priorities ADD COLUMN IF NOT EXISTS carried_over_at text",
    "ALTER TABLE roadmap ADD COLUMN IF NOT EXISTS carried_over_at text",
    `WITH legacy AS (
      SELECT DISTINCT ON (r.gap_id) r.gap_id, p.band AS legacy_band,
        CASE WHEN p.band = 'critical' THEN 'high' ELSE p.band END AS band,
        COALESCE(NULLIF(trim(p.override_reason), ''), 'Carried over from the retired priority board (' || p.band || ').') AS rationale,
        p.lock
      FROM priorities p
      JOIN residuals r ON r.id = p.residual_id
      JOIN gaps g ON g.id = r.gap_id
      WHERE p.carried_over_at IS NULL AND p.lock->>'locked' = 'true'
        AND p.band IN ('critical', 'high', 'medium', 'low') AND ${liveGap}
      ORDER BY r.gap_id, p.id
    ), placed AS (
      INSERT INTO priority_placements
        (gap_id, axis_scores, suggested_band, suggested_rationale, band, validated, rationale,
         actor_name, actor_function, at, human_axes, human_band)
      SELECT gap_id, '{}'::jsonb, band, '', band, true, rationale,
        lock->>'actor_name', lock->>'actor_function', COALESCE(lock->>'locked_at', ${at}), '[]'::jsonb, true
      FROM legacy
      ON CONFLICT (gap_id) DO NOTHING
      RETURNING gap_id, band, actor_name, actor_function
    )
    INSERT INTO audit (id, at, actor_name, actor_function, entity_type, entity_id, action, detail)
    SELECT 'AUD-KAN17-PRI-' || gap_id, ${at}, COALESCE(actor_name, 'Synapse'), COALESCE(actor_function, 'medical_affairs'),
      'gap', gap_id, 'carry_over_priority', 'Validated band ' || band || ' carried over from the retired priority board.'
    FROM placed
    ON CONFLICT (id) DO NOTHING`,
    `UPDATE priorities SET carried_over_at = ${at} WHERE carried_over_at IS NULL`,
    `WITH links AS (
      SELECT DISTINCT ON (r.gap_id, rm.tactic_id) rm.id AS roadmap_id, r.gap_id, rm.tactic_id, rm.lock
      FROM roadmap rm
      CROSS JOIN LATERAL jsonb_array_elements_text(rm.residual_ids) AS link(residual_id)
      JOIN residuals r ON r.id = link.residual_id
      JOIN gaps g ON g.id = r.gap_id
      JOIN tactics t ON t.id = rm.tactic_id
      WHERE rm.carried_over_at IS NULL AND ${liveGap}
        AND t.review_status = 'accepted' AND t.status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM coverages c WHERE c.gap_id = r.gap_id AND c.tactic_id = rm.tactic_id)
        AND NOT EXISTS (
          SELECT 1 FROM mapping_suggestions m
          WHERE m.gap_id = r.gap_id AND m.tactic_id = rm.tactic_id AND m.status = 'rejected'
        )
      ORDER BY r.gap_id, rm.tactic_id, rm.id
    ), mapped AS (
      INSERT INTO coverages
        (id, gap_id, tactic_id, expansion_id, dimensions, overall, overall_rationale, overall_lock, stale, needs_review)
      SELECT 'COV-RM-' || roadmap_id || '-' || gap_id, gap_id, tactic_id, NULL, ${literal(emptyDimensions())}, 'unassessed',
        'Carried over from the retired roadmap, where this tactic was planned against the gap''s residual. Coverage is not assessed yet.',
        ${literal(unlocked())}, false, false
      FROM links
      ON CONFLICT (id) DO NOTHING
      RETURNING id, gap_id, tactic_id
    )
    INSERT INTO audit (id, at, actor_name, actor_function, entity_type, entity_id, action, detail)
    SELECT 'AUD-KAN17-' || mapped.id, ${at}, COALESCE(links.lock->>'actor_name', 'Synapse'),
      COALESCE(links.lock->>'actor_function', 'medical_affairs'), 'gap', mapped.gap_id, 'carry_over_roadmap',
      'Tactic ' || mapped.tactic_id || ' mapped (unassessed), carried over from the retired roadmap.'
    FROM mapped JOIN links ON links.gap_id = mapped.gap_id AND links.tactic_id = mapped.tactic_id
    ON CONFLICT (id) DO NOTHING`,
    `UPDATE roadmap SET carried_over_at = ${at} WHERE carried_over_at IS NULL`,
  ];
}
