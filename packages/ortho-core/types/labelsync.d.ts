// @ortho-earth/core/labelsync — main と render worker の注記の同期。
export function labelKey(...args: unknown[]): string;
export function createLabelSender(): { [k: string]: unknown };
export function createLabelReceiver(): { [k: string]: unknown };
