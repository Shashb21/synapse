import type { LlmProvider } from "@/modules/llm/provider";

export const VELMARA_DEMO_FIXTURE = "velmara-client-demo";
export const isDemoRecordingId = (value: string): boolean => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

/**
 * The route a client-demo workspace gets (KAN-138). It is never listed with the
 * real providers; tracedCompletion answers its calls from the recording.
 */
export const DEMO_REPLAY_PROVIDER: LlmProvider = {
  id: "demo-replay",
  label: "Client demo · recorded run",
  summary: "Replays the recorded client-demo run. No model is called.",
  auth: "api_key",
  models: ["recorded"],
  default_model: "recorded",
  async complete() {
    throw new Error("The demo replay answers through tracedCompletion, which knows the call's stage and purpose.");
  },
};

export const isDemoReplayProvider = (id: string) => id === DEMO_REPLAY_PROVIDER.id;
