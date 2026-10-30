/** Haiku-class models reject the effort parameter (the API's and the claude CLI's). */
export function supportsEffort(model: string): boolean {
  return !/^claude-haiku/.test(model);
}
