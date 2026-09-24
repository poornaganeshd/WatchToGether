export interface Cue {
  start: number;
  end: number;
  text: string;
}

const TIMESTAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

const toSeconds = (stamp: string) => {
  const m = stamp.match(TIMESTAMP);
  if (!m) return NaN;
  const [, h, min, sec, ms] = m;
  return (Number(h) || 0) * 3600 + Number(min) * 60 + Number(sec) + Number(ms.padEnd(3, "0")) / 1000;
};

/** Converts SRT (or passes through WebVTT) into WebVTT text. */
export const toWebVtt = (raw: string): string => {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (text.startsWith("WEBVTT")) return text + "\n";
  const body = text
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      // Drop SRT's numeric cue index.
      if (/^\d+$/.test(lines[0]?.trim() ?? "")) lines.shift();
      if (lines[0]) lines[0] = lines[0].replace(/(\d),(\d)/g, "$1.$2");
      return lines.join("\n");
    })
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
};

/** Parses WebVTT cues; text is kept as plain text (tags are stripped, never rendered as HTML). */
export const parseVtt = (vtt: string): Cue[] => {
  const cues: Cue[] = [];
  for (const block of vtt.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;
    const [from, to] = lines[timingIndex].split("-->");
    const start = toSeconds(from.trim());
    const end = toSeconds(to.trim());
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const text = lines
      .slice(timingIndex + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (text) cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
};

export const activeCues = (cues: Cue[], time: number) => cues.filter((c) => time >= c.start && time <= c.end);
