function splitIntoSentences(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    try {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
      return Array.from(segmenter.segment(text), (s) => s.segment.trim()).filter(
        (s) => s.length > 0
      );
    } catch {
      // fall through to regex
    }
  }
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function formatTimestamp(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function mergeSpeakersWithText(segments, text, durationSeconds) {
  if (!segments || segments.length === 0) {
    return [{ speaker: "speaker_0", text, start: 0, end: durationSeconds || 0 }];
  }

  // Segments arrive in stdout order, not sorted — never assume the last one ends latest.
  const maxSegmentEnd = segments.reduce((max, s) => Math.max(max, s.end || 0), 0);

  const sentences = splitIntoSentences(text);
  if (sentences.length === 0) {
    return [{ speaker: segments[0].speaker, text, start: segments[0].start, end: maxSegmentEnd }];
  }

  const totalDuration = durationSeconds || maxSegmentEnd || 1;
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);

  const assigned = [];
  let charOffset = 0;

  for (const sentence of sentences) {
    const sentenceMidpoint = ((charOffset + sentence.length / 2) / totalChars) * totalDuration;
    charOffset += sentence.length;

    let bestSegment = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const seg of segments) {
      const distance =
        sentenceMidpoint < seg.start
          ? seg.start - sentenceMidpoint
          : sentenceMidpoint > seg.end
            ? sentenceMidpoint - seg.end
            : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestSegment = seg;
      }
      if (distance === 0) break;
    }

    assigned.push({
      speaker: bestSegment.speaker,
      text: sentence,
      start: bestSegment.start,
      end: bestSegment.end,
    });
  }

  return consolidateSpeakerRuns(assigned);
}

function consolidateSpeakerRuns(assigned) {
  const consolidated = [];
  for (const item of assigned) {
    const prev = consolidated[consolidated.length - 1];
    if (prev && prev.speaker === item.speaker) {
      prev.text += " " + item.text;
      prev.end = Math.max(prev.end, item.end);
    } else {
      consolidated.push({ ...item });
    }
  }
  return consolidated;
}

// The diarized speaker for a timed span: the one overlapping it most, else the
// nearest in time.
function speakerForSpan(diarSegments, start, end) {
  let best = null;
  let bestOverlap = 0;
  for (const seg of diarSegments) {
    const overlap = Math.min(end, seg.end) - Math.max(start, seg.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = seg;
    }
  }
  if (best) return best.speaker;

  const midpoint = (start + end) / 2;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const seg of diarSegments) {
    const distance =
      midpoint < seg.start ? seg.start - midpoint : midpoint > seg.end ? midpoint - seg.end : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = seg;
    }
  }
  return best.speaker;
}

// Timed transcript segments (e.g. a server's verbose_json) align to diarization
// by time, not by the character-proportional estimate mergeSpeakersWithText
// has to fall back to. Returns one entry per transcript segment.
function mergeSpeakersWithSegments(diarSegments, textSegments) {
  return textSegments.map((seg) => ({
    speaker: diarSegments.length ? speakerForSpan(diarSegments, seg.start, seg.end) : "speaker_0",
    text: seg.text,
    start: seg.start,
    end: seg.end,
  }));
}

// "Speaker N" labels in order of first appearance, as formatSpeakerTranscript prints them.
function labelSpeakers(segments) {
  const speakerMap = new Map();
  return segments.map((seg) => {
    if (!speakerMap.has(seg.speaker)) speakerMap.set(seg.speaker, speakerMap.size + 1);
    return { ...seg, speaker: `Speaker ${speakerMap.get(seg.speaker)}` };
  });
}

function formatSpeakerTranscript(mergedSegments) {
  const speakerMap = new Map();
  let nextIndex = 1;

  return mergedSegments
    .map((seg) => {
      if (!speakerMap.has(seg.speaker)) {
        speakerMap.set(seg.speaker, nextIndex++);
      }
      const label = `Speaker ${speakerMap.get(seg.speaker)}`;
      const timeRange = `${formatTimestamp(seg.start)} - ${formatTimestamp(seg.end)}`;
      return `[${label}] ${timeRange}\n${seg.text}`;
    })
    .join("\n\n");
}

module.exports = {
  mergeSpeakersWithText,
  mergeSpeakersWithSegments,
  consolidateSpeakerRuns,
  labelSpeakers,
  formatSpeakerTranscript,
  splitIntoSentences,
  formatTimestamp,
};
