// Quiet log mode (PB_LOG_QUIET=1). Some lines are written on EVERY login (31 "Attendance day N: skipped good ..." lines plus the
// EventLogin one per player), which buries everything else once a few players are online. With PB_LOG_QUIET=1 those lines are hidden
// and ONE note line appears the first time, so it is clear that something is being hidden. PB_LOG_QUIET=0 shows them again.
// PB_LOG_HIDE=<regex> additionally drops every line that matches. It filters process.stdout / process.stderr, so it also covers log
// lines that are written without console.log. Import this file FIRST in main.ts. Off by default.
import { config } from "./config.ts";

if (config.logQuiet) {
  const noisy = [
    /\[auth-ts\] Attendance day \d+: skipped good \d+/, // attendance reward whose good is not in the packed client catalog
    /\[player\] \[EventLogin\] Good \d+ is not in the shop/, // login gift whose good is not in the shop
  ];
  const NOTE = "[log] quiet mode: per-login lines about goods missing from the catalog (attendance / login gift) are hidden; PB_LOG_QUIET=0 shows them";
  // PB_LOG_HIDE: a regex that is too short ("1") would hide almost every line, an invalid one must not stop the server
  let hide: RegExp | null = null;
  let hideWarn = "";
  if (config.logHide) {
    if (config.logHide.trim().length < 1) hideWarn = `PB_LOG_HIDE=${config.logHide} is too short (it would hide almost every line): ignored`;
    else {
      try { hide = new RegExp(config.logHide); } catch (e) { hideWarn = `PB_LOG_HIDE is not a valid regex (${(e as Error).message}): ignored`; }
    }
  }
  let noted = false;

  /** the line to print, or null to drop it */
  const map = (line: string): string | null => {
    if (noisy.some((re) => re.test(line))) {
      if (noted) return null;
      noted = true;
      return NOTE;
    }
    return hide && hide.test(line) ? null : line;
  };

  // printed before the filter is installed, so a PB_LOG_HIDE pattern can never hide this confirmation
  console.log(`[log] quiet mode on (PB_LOG_QUIET=1)${hide ? `, also hiding /${config.logHide}/` : ""}`);
  if (hideWarn) console.warn(`[log] ${hideWarn}`);

  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    (stream as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]): boolean => {
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return write(chunk, ...rest);
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const lines = text.split("\n");
      const last = lines.length - 1; // "" after the final newline: always kept
      const out = lines.map((l, i) => (i === last && l === "" ? l : map(l))).filter((l): l is string => l !== null).join("\n");
      if (out === "") { // everything in this chunk was hidden: still honour the write callback
        const cb = rest.find((x) => typeof x === "function") as (() => void) | undefined;
        cb?.();
        return true;
      }
      return write(out, ...rest);
    };
  }
}