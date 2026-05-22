import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");

test("composer exposes local dictation controls", () => {
  assert.match(
    composerSource,
    /import \{[^}]*Mic[^}]*MicOff[^}]*\} from "lucide-solid";/s,
    "composer should use recognizable microphone icons for local dictation",
  );

  assert.match(
    composerSource,
    /transcribeDictationAudio/,
    "composer should route dictation audio through the local Tauri transcription command",
  );

  assert.match(
    composerSource,
    /navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/,
    "composer should capture microphone audio locally through the browser media API",
  );

  assert.match(
    composerSource,
    /insertDictationText/,
    "composer should insert transcribed text into the current editor draft",
  );
});

test("composer shows live local dictation feedback while recording", () => {
  assert.match(
    composerSource,
    /dictationPreview/,
    "composer should keep an interim dictation preview separate from the final editor draft",
  );

  assert.match(
    composerSource,
    /AudioContext|webkitAudioContext/,
    "composer should use local audio analysis for an immediate recording activity meter",
  );

  assert.match(
    composerSource,
    /transcribeDictationPreviewBlob/,
    "composer should attempt local interim transcription while recording",
  );

  assert.match(
    composerSource,
    /dictationLevel/,
    "composer should expose microphone activity feedback so recording does not look dead",
  );
});
