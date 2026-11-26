/** An authored validator instruction can quote a rejected model value in its wire message. */
export type RepairMessage = string | { text: string; instruction: string };

export function quotedRepair(value: string, render: (value: string) => string): RepairMessage {
  return { text: render(value), instruction: render("<model value>") };
}

export function repairText(message: RepairMessage): string {
  return typeof message === "string" ? message : message.text;
}

/** Render the actual user payload and fingerprint its server-authored repair wording from the same messages. */
export function repairUserMessage(payload: (describe: (message: RepairMessage) => string) => unknown) {
  const repairGuidance: string[] = [];
  const user = JSON.stringify(
    payload((message) => {
      repairGuidance.push(typeof message === "string" ? message : message.instruction);
      return repairText(message);
    }),
  );
  return { user, repairGuidance };
}
