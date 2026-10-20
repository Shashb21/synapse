/** Server adapter for source pages and full gap records. */
import { SourceClaimReviewContent } from "./source-claim-review-content";
import { sourceClaimReviewData } from "@/lib/iegp/source-review";
import type { ActionIdentity } from "@/components/platform/action-dialog";
import type { IegpState } from "@/lib/iegp/types";

/** Compute review tokens before passing presentation data to the shared controls. */
export function SourceClaimReview({ state, identity, canReview, ...scope }: {
  state: IegpState; identity: ActionIdentity; canReview: boolean; sourceId?: string; gapId?: string; tacticId?: string;
}) {
  return <SourceClaimReviewContent data={sourceClaimReviewData(state, scope)} identity={identity} canReview={canReview} />;
}
