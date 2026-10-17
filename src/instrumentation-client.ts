import { installTacticDraftNavigation } from "@/lib/tactic-draft-navigation";

// Observe native history before Next starts routing; block only while a draft is protected.
installTacticDraftNavigation();
