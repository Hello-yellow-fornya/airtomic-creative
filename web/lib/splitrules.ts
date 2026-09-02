/** Minimum distance (seconds) a split may land from a scene edge —
 * ~4-5 frames at 30fps. Shared by the split API, the Split button's
 * disabled state and the timeline's hover cut line, so they can't
 * disagree. (Was 0.5s — too strict: half a second is a usable beat.)
 * Client-safe module: no server imports. */
export const SPLIT_EDGE_S = 0.15;
