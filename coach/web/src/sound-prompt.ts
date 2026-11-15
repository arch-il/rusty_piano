export const SOUND_PROMPT_TEXT = 'Click to enable sound';
export const SOUND_PROMPT_DELAY_MS = 300;

export function soundPromptVisible(s: { audio: string; muted: boolean; active: boolean; posMs: number }): boolean {
  return s.active && !s.muted && s.audio === 'suspended' && s.posMs >= SOUND_PROMPT_DELAY_MS;
}
