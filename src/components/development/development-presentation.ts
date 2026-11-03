/** Presentation only: persisted freshness and compatibility decisions remain authoritative. */
const reasons: Record<string, string> = {
  newer_attempt: 'A newer attempt exists', generation_inputs_changed: 'Generation inputs or settings changed', attempt_changed: 'The saved attempt or output changed',
  source_changed: 'Source documents changed', sources_changed: 'Source documents changed',
  config_changed: 'Generation settings changed', configuration_changed: 'Generation settings changed',
  output_changed: 'The selected saved output changed', profile_changed: 'Evaluation criteria changed',
  evaluator_changed: 'Evaluator settings changed', references_changed: 'Gold standard references changed',
  prerequisite_changed: 'An earlier section output changed', prerequisites_changed: 'Earlier section outputs changed',
  prompt_changed: 'Generation instructions changed', module_changed: 'Generation module changed',
  source_content: 'Source document content', profile_version: 'Evaluation profile version',
  sources: 'Source documents', references: 'Gold standard references', reference_identity: 'Gold standard identities',
  evaluator_configuration: 'Evaluator settings', generation_mode: 'Generation mode', generation_routes: 'Generation models',
  target: 'Generation target', generation_code: 'Generation code version', source_lineage: 'Source document lineage',
  prerequisite_outputs: 'Earlier section outputs', module: 'Generation module version', prompt: 'Generation instructions',
  evaluation_section: 'Evaluated section', profile: 'Evaluation profile', criteria: 'Scoring criteria',
  evaluator_route: 'Resolved evaluator model', evaluator_version: 'Evaluator code version', evaluation_sources: 'Evaluation source documents',
  reference_configuration: 'Gold standard settings', evaluation_output_binding: 'Exact evaluated output',
  evaluation_generation_binding: 'Original generation settings', sections: 'Saved sections',
  valid_immutable_output: 'Valid saved output', bound_evaluations: 'Evaluations bound to these outputs',
  successful_generation: 'Successful generation', section_missing: 'Section absent from one run',
};
/** Translate saved reason codes for display; retain readable text for unknown codes. */
export function presentationReason(code: string): string {
  if (reasons[code]) return reasons[code];
  const separator = code.indexOf(':');
  if (separator >= 0) return `${presentationReason(code.slice(0, separator))}: ${presentationReason(code.slice(separator + 1))}`;
  if (code.startsWith('left_') || code.startsWith('right_')) {
    const side = code.startsWith('left_') ? 'Left' : 'Right';
    return `${side}: ${presentationReason(code.slice(side.length + 1))}`;
  }
  return code.replaceAll('_', ' ');
}
