"use strict";

const { createSilentWav } = require("./lib/audio.js");

class TTS {
  async textToSpeech() {
    return createSilentWav();
  }
}

module.exports = { default: TTS };
