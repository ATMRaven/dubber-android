/**
 * Dubber — Real-Time Voice Dubbing & Translation Engine
 * 
 * Pipeline:
 *  1. Dual Audio Capture: Screen/Tab digital internal audio (default) + Microphone.
 *  2. Real-Time STT: Web Speech API (continuous) + sentence/clause-level chunk streaming.
 *  3. Fast Translation: OpenRouter API with free LLMs (LLaMA 3.2 3B, Gemini 2.0 Flash) + client fallbacks.
 *  4. Instant TTS & Audio Ducking: Gapless FIFO playback queue, dynamic Web Audio API gain ducking.
 *  5. Draggable Pill UI & Full Studio Configuration Drawer.
 */

(() => {
  'use strict';

  // =========================================================================
  // 1. CONFIGURATION & STATE
  // =========================================================================

  const STORAGE_KEYS = {
    API_KEY: 'dubber_openrouter_api_key',
    MODEL: 'dubber_translation_model',
    CUSTOM_MODEL: 'dubber_custom_model',
    SRC_LANG: 'dubber_src_lang',
    TGT_LANG: 'dubber_tgt_lang',
    TTS_ENGINE: 'dubber_tts_engine',
    VOICE_URI: 'dubber_voice_uri',
    VOICE_RATE: 'dubber_voice_rate',
    VOICE_PITCH: 'dubber_voice_pitch',
    DUCKING_ENABLED: 'dubber_ducking_enabled',
    DUCKING_DEPTH: 'dubber_ducking_depth',
    CAPTURE_SOURCE: 'dubber_capture_source',
    MIC_PASSTHROUGH: 'dubber_mic_passthrough',
    ROUTE_SCREEN_TO_OUTPUT: 'dubber_route_screen_to_output',
    LOOKAHEAD_SYNC_ENABLED: 'dubber_lookahead_sync_enabled',
    LOOKAHEAD_DELAY: 'dubber_lookahead_delay',
    PILL_POS: 'dubber_pill_pos'
  };

  const isNativeAndroid = () => {
    return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  };

  const getAudioCapturePlugin = () => {
    if (!window.Capacitor) return null;
    if (window.Capacitor.Plugins && window.Capacitor.Plugins.AudioCapture) {
      return window.Capacitor.Plugins.AudioCapture;
    }
    if (typeof window.Capacitor.registerPlugin === 'function') {
      try {
        const plugin = window.Capacitor.registerPlugin('AudioCapture');
        if (plugin) return plugin;
      } catch (e) {
        console.warn('Failed to register AudioCapture plugin:', e);
      }
    }
    return window.Capacitor.Plugins ? window.Capacitor.Plugins.AudioCapture : null;
  };

  const hasDisplayMediaSupport = () => {
    if (isNativeAndroid()) {
      return true; // Native Android APK with AudioPlaybackCapture supports internal screen audio!
    }
    return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
  };

  const state = {
    isDubbing: false,
    status: 'idle', // 'idle' | 'listening' | 'translating' | 'dubbing' | 'error'
    captureSource: isNativeAndroid()
      ? 'display'
      : (localStorage.getItem(STORAGE_KEYS.CAPTURE_SOURCE) === 'display' && !hasDisplayMediaSupport())
        ? 'mic'
        : (localStorage.getItem(STORAGE_KEYS.CAPTURE_SOURCE) || (hasDisplayMediaSupport() ? 'display' : 'mic')),
    micPassthrough: localStorage.getItem(STORAGE_KEYS.MIC_PASSTHROUGH) === 'true',
    routeScreenToOutput: localStorage.getItem(STORAGE_KEYS.ROUTE_SCREEN_TO_OUTPUT) === 'true',
    lookaheadSyncEnabled: localStorage.getItem(STORAGE_KEYS.LOOKAHEAD_SYNC_ENABLED) === 'true',
    lookaheadDelay: parseFloat(localStorage.getItem(STORAGE_KEYS.LOOKAHEAD_DELAY)) || 2.5,
    screenDelayNode: null,
    
    // Languages
    srcLang: localStorage.getItem(STORAGE_KEYS.SRC_LANG) || 'en-US',
    tgtLang: (function() {
      const saved = localStorage.getItem(STORAGE_KEYS.TGT_LANG);
      const supported = ['fr-FR', 'en-US', 'es-ES', 'de-DE', 'ja-JP', 'it-IT', 'nl-NL'];
      return (saved && supported.includes(saved)) ? saved : 'fr-FR';
    })(),

    // Translation Engine & OpenRouter Settings
    apiKey: localStorage.getItem(STORAGE_KEYS.API_KEY) || '',
    model: (function() {
      const saved = localStorage.getItem(STORAGE_KEYS.MODEL);
      if (!saved || saved.includes('nemotron') || saved.includes('lfm-2.5') || saved.includes('llama-3.2-3b') || saved === 'default') {
        return 'groq-server';
      }
      return saved;
    })(),
    customModel: localStorage.getItem(STORAGE_KEYS.CUSTOM_MODEL) || '',

    // TTS & Voice
    ttsEngine: localStorage.getItem(STORAGE_KEYS.TTS_ENGINE) || 'mistral',
    mistralVoice: localStorage.getItem('dubber_mistral_voice') || 'fr_marie_happy',
    voiceUri: localStorage.getItem(STORAGE_KEYS.VOICE_URI) || '',
    voiceRate: parseFloat(localStorage.getItem(STORAGE_KEYS.VOICE_RATE)) || 1.10,
    voicePitch: parseFloat(localStorage.getItem(STORAGE_KEYS.VOICE_PITCH)) || 1.00,
    openRouterVoiceSlug: localStorage.getItem('dubber_or_voice_slug') || 'openai/tts-1',

    // Dynamic Audio Ducking
    duckingEnabled: localStorage.getItem(STORAGE_KEYS.DUCKING_ENABLED) !== 'false',
    duckingDepth: parseInt(localStorage.getItem(STORAGE_KEYS.DUCKING_DEPTH), 10) || 20, // 20% background audio (-80% duck)
    isDucked: false,

    // Audio Graph Objects
    audioCtx: null,
    mediaStream: null,
    sourceNode: null,
    duckingGainNode: null,
    analyserNode: null,
    dataArray: null,
    animFrameId: null,

    // Speech Recognition
    recognition: null,
    recognitionRestartTimer: null,
    pendingUtteranceBuffer: '',
    lastUtteranceTime: 0,

    // Streaming Audio Playback Queue (FIFO)
    ttsQueue: [],
    isAudioPlaying: false,
    nextScheduleTime: 0,

    // Session Transcripts
    transcripts: []
  };

  // =========================================================================
  // 2. DOM REFERENCES
  // =========================================================================

  const elements = {
    // Floating Pill
    floatingPill: document.getElementById('floatingPill'),
    pillGrip: document.getElementById('pillGrip'),
    pillToggleBtn: document.getElementById('pillToggleBtn'),
    pillToggleIcon: document.getElementById('pillToggleIcon'),
    pillToggleLabel: document.getElementById('pillToggleLabel'),
    pillStatus: document.getElementById('pillStatus'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    pillLangBadge: document.getElementById('pillLangBadge'),
    pillSrcBadge: document.getElementById('pillSrcBadge'),
    pillTgtBadge: document.getElementById('pillTgtBadge'),
    pillVuMeter: document.getElementById('pillVuMeter'),
    vuBar: document.getElementById('vuBar'),
    pillTicker: document.getElementById('pillTicker'),
    tickerText: document.getElementById('tickerText'),
    openDrawerBtn: document.getElementById('openDrawerBtn'),

    // Main Workspace
    headerTestSpeechBtn: document.getElementById('headerTestSpeechBtn'),
    headerSettingsBtn: document.getElementById('headerSettingsBtn'),
    statSource: document.getElementById('statSource'),
    statDuckingVal: document.getElementById('statDuckingVal'),
    statEngineVal: document.getElementById('statEngineVal'),
    labelSrcLang: document.getElementById('labelSrcLang'),
    labelTgtLang: document.getElementById('labelTgtLang'),
    liveOriginalTranscript: document.getElementById('liveOriginalTranscript'),
    liveTranslatedTranscript: document.getElementById('liveTranslatedTranscript'),
    visDbLevel: document.getElementById('visDbLevel'),
    visualizerCanvas: document.getElementById('audioVisualizerCanvas'),

    // Test Bench & YouTube
    youtubePlayer: document.getElementById('youtubePlayer'),
    youtubeUrlInput: document.getElementById('youtubeUrlInput'),
    loadYoutubeBtn: document.getElementById('loadYoutubeBtn'),
    lookaheadSyncToggle: document.getElementById('lookaheadSyncToggle'),
    syncSliderGroup: document.getElementById('syncSliderGroup'),
    lookaheadDelaySlider: document.getElementById('lookaheadDelaySlider'),
    lookaheadDelayVal: document.getElementById('lookaheadDelayVal'),
    lookaheadVideoCanvas: document.getElementById('lookaheadVideoCanvas'),
    capturedVideoElement: document.getElementById('capturedVideoElement'),
    lookaheadBadge: document.getElementById('lookaheadBadge'),
    lookaheadBadgeText: document.getElementById('lookaheadBadgeText'),

    // Transcript Log
    copyTranscriptBtn: document.getElementById('copyTranscriptBtn'),
    downloadTranscriptBtn: document.getElementById('downloadTranscriptBtn'),
    clearTranscriptBtn: document.getElementById('clearTranscriptBtn'),
    transcriptLogBody: document.getElementById('transcriptLogBody'),

    // Settings Drawer
    drawerBackdrop: document.getElementById('drawerBackdrop'),
    settingsDrawer: document.getElementById('settingsDrawer'),
    closeDrawerBtn: document.getElementById('closeDrawerBtn'),
    sourceMicRadio: document.getElementById('sourceMicRadio'),
    sourceDisplayRadio: document.getElementById('sourceDisplayRadio'),
    routeScreenToOutputToggle: document.getElementById('routeScreenToOutputToggle'),
    micLoopbackToggle: document.getElementById('micLoopbackToggle'),
    srcLangSelect: document.getElementById('srcLangSelect'),
    tgtLangSelect: document.getElementById('tgtLangSelect'),
    swapLangsBtn: document.getElementById('swapLangsBtn'),
    openRouterKeyInput: document.getElementById('openRouterKeyInput'),
    keyStatusBadge: document.getElementById('keyStatusBadge'),
    toggleKeyVisibilityBtn: document.getElementById('toggleKeyVisibilityBtn'),
    modelSelect: document.getElementById('modelSelect'),
    customModelInput: document.getElementById('customModelInput'),
    testApiKeyBtn: document.getElementById('testApiKeyBtn'),
    ttsEngineSelect: document.getElementById('ttsEngineSelect'),
    mistralVoiceGroup: document.getElementById('mistralVoiceGroup'),
    mistralVoiceSelect: document.getElementById('mistralVoiceSelect'),
    speechSynthVoiceGroup: document.getElementById('speechSynthVoiceGroup'),
    refreshVoicesBtn: document.getElementById('refreshVoicesBtn'),
    voiceSelect: document.getElementById('voiceSelect'),
    openRouterVoiceGroup: document.getElementById('openRouterVoiceGroup'),
    openRouterVoiceSlug: document.getElementById('openRouterVoiceSlug'),
    voiceRateSlider: document.getElementById('voiceRateSlider'),
    voiceRateVal: document.getElementById('voiceRateVal'),
    voicePitchSlider: document.getElementById('voicePitchSlider'),
    voicePitchVal: document.getElementById('voicePitchVal'),
    testVoiceBtn: document.getElementById('testVoiceBtn'),
    duckingEnabledCheck: document.getElementById('duckingEnabledCheck'),
    duckingDepthSlider: document.getElementById('duckingDepthSlider'),
    duckingDepthVal: document.getElementById('duckingDepthVal'),
    resetDefaultsBtn: document.getElementById('resetDefaultsBtn'),
    saveDrawerBtn: document.getElementById('saveDrawerBtn'),

    // Utilities
    toastContainer: document.getElementById('toastContainer'),
    demoAudioPlayer: document.getElementById('demoAudioPlayer')
  };

  // =========================================================================
  // 3. TOAST NOTIFICATIONS & STATUS HELPERS
  // =========================================================================

  function showToast(message, type = 'info', duration = 3500) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 200ms ease';
      setTimeout(() => toast.remove(), 220);
    }, duration);
  }

  function setStatus(status, customText) {
    state.status = status;
    elements.statusDot.className = `status-dot status-${status}`;
    
    let text = 'Ready';
    if (status === 'listening') text = 'Listening';
    else if (status === 'translating') text = 'Translating';
    else if (status === 'dubbing') text = 'Dubbing';
    else if (status === 'error') text = 'Error';

    elements.statusText.textContent = customText || text;
    elements.pillStatus.title = `System Status: ${customText || text}`;
  }

  function updateTicker(text, type = 'normal') {
    if (!text) return;
    elements.tickerText.textContent = text;
    elements.tickerText.style.animation = 'none';
    void elements.tickerText.offsetWidth; // trigger reflow
    elements.tickerText.style.animation = 'ticker-fade 250ms ease-out';
  }

  // =========================================================================
  // 4. AUDIO GRAPH & DYNAMIC AUDIO DUCKING (Web Audio API)
  // =========================================================================

  function initAudioContext() {
    if (!state.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new AudioContextClass();
    }
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }
    return state.audioCtx;
  }

  /**
   * Smoothly duck or restore source audio gain (Supports Native Android System Ducking + Web Audio)
   */
  function applyDucking(duck) {
    if (!state.duckingEnabled) return;
    state.isDucked = duck;

    // 1. Native Android System Audio Focus Ducking (lowers YouTube, Spotify, etc.)
    const audioPlugin = getAudioCapturePlugin();
    if (isNativeAndroid() && audioPlugin) {
      try {
        if (duck) {
          audioPlugin.requestDuck().catch(() => {});
        } else {
          audioPlugin.abandonDuck().catch(() => {});
        }
      } catch (e) {}
    }

    // 2. Web Audio API Ducking (Desktop tab or mic)
    if (state.duckingGainNode && state.audioCtx) {
      const ctx = state.audioCtx;
      const now = ctx.currentTime;
      const targetGain = duck ? (state.duckingDepth / 100) : 1.0;
      const rampTime = duck ? 0.12 : 0.28; // Rapid duck (120ms), smooth recovery (280ms)

      state.duckingGainNode.gain.cancelScheduledValues(now);
      state.duckingGainNode.gain.setValueAtTime(state.duckingGainNode.gain.value, now);
      state.duckingGainNode.gain.linearRampToValueAtTime(targetGain, now + rampTime);
    }

    // 3. Embedded YouTube player iframe if active
    if (elements.youtubePlayer && elements.youtubePlayer.contentWindow) {
      try {
        const vol = duck ? state.duckingDepth : 100;
        elements.youtubePlayer.contentWindow.postMessage(JSON.stringify({
          event: 'command',
          func: 'setVolume',
          args: [vol]
        }), '*');
      } catch (e) {}
    }

    // 4. Update Pill & Stats
    if (duck) {
      const depthDesc = state.duckingDepth === 0 ? 'Muted (100% duck)' : `${state.duckingDepth}% (-${100 - state.duckingDepth}%)`;
      elements.statDuckingVal.textContent = `Ducking Active (${depthDesc})`;
      elements.statDuckingVal.style.color = '#38bdf8';
    } else {
      elements.statDuckingVal.textContent = `Normal (100%)`;
      elements.statDuckingVal.style.color = '';
    }
  }

  /**
   * Set up Web Audio pipeline for stream
   */
  function setupAudioGraph(stream, isScreenAudio) {
    const ctx = initAudioContext();

    // Disconnect old nodes if present
    if (state.sourceNode) {
      try { state.sourceNode.disconnect(); } catch (e) {}
    }
    if (state.screenDelayNode) {
      try { state.screenDelayNode.disconnect(); } catch (e) {}
      state.screenDelayNode = null;
    }

    state.sourceNode = ctx.createMediaStreamSource(stream);
    state.duckingGainNode = ctx.createGain();
    state.duckingGainNode.gain.setValueAtTime(1.0, ctx.currentTime);

    state.analyserNode = ctx.createAnalyser();
    state.analyserNode.fftSize = 256;
    state.dataArray = new Uint8Array(state.analyserNode.frequencyBinCount);

    state.sourceNode.connect(state.duckingGainNode);
    state.duckingGainNode.connect(state.analyserNode);

    // CRITICAL ANTI-ECHO AUDIO ROUTING LOGIC:
    // When capturing Screen/Tab:
    // 1. If Chrome suppressed local tab playback (suppressLocalAudioPlayback: true),
    //    Dubber is the sole audio channel -> route to destination so user hears the video!
    // 2. If local playback was NOT suppressed (browser is already outputting sound directly to headphones),
    //    routing to destination creates a 40ms flanging echo! We do NOT route duplicate audio
    //    unless the user explicitly checked state.routeScreenToOutput.
    // 3. When Lookahead Lip-Sync is enabled, background screen audio routes through a DelayNode
    //    so the original audio remains in exact lockstep with the delayed video on canvas!
    const audioTrack = stream.getAudioTracks()[0];
    const isLocalSuppressed = audioTrack && typeof audioTrack.getSettings === 'function' && audioTrack.getSettings().suppressLocalAudioPlayback === true;

    if (isScreenAudio) {
      if (isLocalSuppressed || state.routeScreenToOutput) {
        if (state.lookaheadSyncEnabled) {
          state.screenDelayNode = ctx.createDelay(10.0);
          state.screenDelayNode.delayTime.setValueAtTime(state.lookaheadDelay, ctx.currentTime);
          state.duckingGainNode.connect(state.screenDelayNode);
          state.screenDelayNode.connect(ctx.destination);
        } else {
          state.duckingGainNode.connect(ctx.destination);
        }
      }
    } else if (state.micPassthrough) {
      state.duckingGainNode.connect(ctx.destination);
    }

    // Direct Digital Audio Track Chunker (Captures screen/tab audio directly for STT without mic)
    startDigitalAudioChunker();

    startVisualizer();
  }

  // =========================================================================
  // 4B. DIGITAL AUDIO STREAM PROCESSOR & WAV ENCODER
  // =========================================================================

  function floatTo16BitPCM(output, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, input[i]));
      output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
  }

  function writeWavHeader(view, length, sampleRate) {
    view.setUint32(0, 0x52494646, false); // "RIFF"
    view.setUint32(4, 36 + length, true);
    view.setUint32(8, 0x57415645, false); // "WAVE"
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM = 1
    view.setUint16(22, 1, true); // Mono = 1
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    view.setUint32(36, 0x64617461, false); // "data"
    view.setUint32(40, length, true);
  }

  function encodeWavBlob(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    writeWavHeader(view, samples.length * 2, sampleRate);
    floatTo16BitPCM(view, 44, samples);
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function downsampleBuffer(buffer, sampleRate, outSampleRate) {
    if (outSampleRate === sampleRate) return buffer;
    const ratio = sampleRate / outSampleRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  let activeSpeechSamples = [];
  let isSpeechActive = false;
  let silenceFrames = 0;
  let preSpeechRingBuffer = [];
  const PRE_RING_MAX = 3;

  let activeNativeSamples = [];
  let isNativeSpeechActive = false;
  let nativeSilenceFrames = 0;
  let nativePreRingBuffer = [];
  const NATIVE_PRE_RING_MAX = 3;

  let isTranscribingChunk = false;

  function startDigitalAudioChunker() {
    if (!state.audioCtx || !state.sourceNode) return;
    const ctx = state.audioCtx;

    // Disconnect previous processor if any
    stopDigitalAudioChunker();

    // Use ScriptProcessorNode to tap digital audio stream
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    activeSpeechSamples = [];
    isSpeechActive = false;
    silenceFrames = 0;
    preSpeechRingBuffer = [];

    processor.onaudioprocess = (e) => {
      if (!state.isDubbing) return;
      const input = e.inputBuffer.getChannelData(0);

      // Compute RMS volume
      let sum = 0;
      for (let i = 0; i < input.length; i++) {
        sum += input[i] * input[i];
      }
      const rms = Math.sqrt(sum / input.length);

      const SPEECH_THRESHOLD = 0.009;   // Spoken dialogue cutoff
      const SILENCE_FRAMES_TRIGGER = 9; // ~0.8s pause marks natural clause boundary
      const MAX_FRAMES_PER_CHUNK = 36;  // ~3.4s max phrase chunk for rapid response

      if (rms >= SPEECH_THRESHOLD) {
        if (!isSpeechActive) {
          isSpeechActive = true;
          setStatus('listening');
          // Include pre-speech buffer so onset consonants aren't clipped
          while (preSpeechRingBuffer.length > 0) {
            activeSpeechSamples.push(preSpeechRingBuffer.shift());
          }
        }
        silenceFrames = 0;
        activeSpeechSamples.push(new Float32Array(input));

        // Cut chunk immediately if max phrase duration reached even during loud continuous audio
        if (activeSpeechSamples.length >= MAX_FRAMES_PER_CHUNK) {
          dispatchDigitalAudioChunk(false);
        }
      } else if (isSpeechActive) {
        activeSpeechSamples.push(new Float32Array(input));
        silenceFrames++;

        if (silenceFrames >= SILENCE_FRAMES_TRIGGER || activeSpeechSamples.length >= MAX_FRAMES_PER_CHUNK) {
          dispatchDigitalAudioChunk(false);
        }
      } else {
        // Rolling pre-speech buffer
        preSpeechRingBuffer.push(new Float32Array(input));
        if (preSpeechRingBuffer.length > PRE_RING_MAX) {
          preSpeechRingBuffer.shift();
        }
      }

      // CRITICAL: Explicitly clear output buffer to guarantee ZERO un-ducked audio leakage to speakers!
      if (e.outputBuffer && e.outputBuffer.numberOfChannels > 0) {
        for (let c = 0; c < e.outputBuffer.numberOfChannels; c++) {
          e.outputBuffer.getChannelData(c).fill(0);
        }
      }
    };

    state.sourceNode.connect(processor);
    // Connect through a hard 0-gain mute node to keep ScriptProcessor running without sound leakage
    const muteNode = ctx.createGain();
    muteNode.gain.setValueAtTime(0, ctx.currentTime);
    processor.connect(muteNode);
    muteNode.connect(ctx.destination);
    state.digitalProcessorNode = processor;
    state.digitalProcessorMuteNode = muteNode;
  }

  function handleNativePcmChunk(base64Data) {
    if (!state.isDubbing) return;
    // Acoustic Echo Suppression: Ignore incoming audio while Dubber is actively playing speech
    if (state.isDucked || isPipelinePlaying) return;

    try {
      const binaryStr = atob(base64Data);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      let sum = 0;
      for (let i = 0; i < int16.length; i++) {
        const val = int16[i] / 32768.0;
        float32[i] = val;
        sum += val * val;
      }
      const rms = Math.sqrt(sum / float32.length);

      // Fast mobile voice activity detection (VAD) thresholds
      const NATIVE_SPEECH_THRESHOLD = 0.005; // Sensitive to mobile speech
      const NATIVE_SILENCE_TRIGGER = 3;     // ~380ms pause -> immediate dispatch!
      const NATIVE_MAX_FRAMES = 12;         // ~1.5s max speech chunk -> fast, natural phrases!

      if (rms >= NATIVE_SPEECH_THRESHOLD) {
        if (!isNativeSpeechActive) {
          isNativeSpeechActive = true;
          setStatus('listening');
          while (nativePreRingBuffer.length > 0) {
            activeNativeSamples.push(nativePreRingBuffer.shift());
          }
        }
        nativeSilenceFrames = 0;
        activeNativeSamples.push(float32);

        // Cut chunk immediately if max speech frames reached even during continuous audio!
        if (activeNativeSamples.length >= NATIVE_MAX_FRAMES) {
          dispatchDigitalAudioChunk(true);
        }
      } else if (isNativeSpeechActive) {
        activeNativeSamples.push(float32);
        nativeSilenceFrames++;

        if (nativeSilenceFrames >= NATIVE_SILENCE_TRIGGER || activeNativeSamples.length >= NATIVE_MAX_FRAMES) {
          dispatchDigitalAudioChunk(true);
        }
      } else {
        nativePreRingBuffer.push(float32);
        if (nativePreRingBuffer.length > NATIVE_PRE_RING_MAX) {
          nativePreRingBuffer.shift();
        }
      }
    } catch (e) {
      console.warn('Native PCM chunk handling error:', e);
    }
  }

  async function dispatchDigitalAudioChunk(isNative = false) {
    const rawChunks = isNative ? activeNativeSamples : activeSpeechSamples;
    if (rawChunks.length === 0) return;

    // Snapshot and CLEAR accumulator immediately so new incoming frames never accumulate into a giant buffer
    const samplesArray = [...rawChunks];
    if (isNative) {
      activeNativeSamples = [];
      isNativeSpeechActive = false;
      nativeSilenceFrames = 0;
    } else {
      activeSpeechSamples = [];
      isSpeechActive = false;
      silenceFrames = 0;
    }

    if (isTranscribingChunk) return;

    let totalLength = 0;
    for (const chunk of samplesArray) totalLength += chunk.length;

    const sourceRate = isNative ? 16000 : (state.audioCtx ? state.audioCtx.sampleRate : 48000);

    // Skip very brief acoustic noise (< 0.2s)
    if (totalLength < sourceRate * 0.2) {
      return;
    }

    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of samplesArray) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    // STRICT VAD ENERGY CHECK: Compute overall RMS energy of the merged buffer
    let energySum = 0;
    for (let i = 0; i < merged.length; i++) {
      energySum += merged[i] * merged[i];
    }
    const overallRms = Math.sqrt(energySum / merged.length);
    if (overallRms < 0.004) {
      // Discard silence or sub-audible hiss
      return;
    }

    // Downsample only if source rate is not 16kHz
    const downsampled = (sourceRate === 16000) ? merged : downsampleBuffer(merged, sourceRate, 16000);
    const wavBlob = encodeWavBlob(downsampled, 16000);

    isTranscribingChunk = true;
    try {
      const transcribeUrl = `https://dubber.atmr.workers.dev/api/transcribe?lang=${encodeURIComponent(state.srcLang)}`;
      const res = await fetch(transcribeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wavBlob
      });

      if (res.ok) {
        const data = await res.json();
        if (data.text && data.text.trim()) {
          const phrase = data.text.trim();
          const captureCtxTime = state.audioCtx ? state.audioCtx.currentTime : 0;
          elements.liveOriginalTranscript.textContent = phrase;
          updateTicker(`"${phrase.slice(-40)}"`, 'listening');
          dispatchUtteranceChunk(phrase, captureCtxTime);
        }
      }
    } catch (err) {
      console.warn('Digital stream transcription error:', err);
    } finally {
      isTranscribingChunk = false;
    }
  }

  function stopDigitalAudioChunker() {
    if (state.digitalProcessorNode) {
      try {
        state.digitalProcessorNode.disconnect();
      } catch (e) {}
      state.digitalProcessorNode = null;
    }
    if (state.digitalProcessorMuteNode) {
      try {
        state.digitalProcessorMuteNode.disconnect();
      } catch (e) {}
      state.digitalProcessorMuteNode = null;
    }
    activeSpeechSamples = [];
    isSpeechActive = false;
    silenceFrames = 0;
    preSpeechRingBuffer = [];
    activeNativeSamples = [];
    isNativeSpeechActive = false;
    nativeSilenceFrames = 0;
    nativePreRingBuffer = [];
    isTranscribingChunk = false;
  }

  function stopAudioGraph() {
    stopDigitalAudioChunker();
    stopLookaheadVideoLoop();

    if (state.animFrameId) {
      cancelAnimationFrame(state.animFrameId);
      state.animFrameId = null;
    }
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(track => track.stop());
      state.mediaStream = null;
    }
    if (state.screenDelayNode) {
      try { state.screenDelayNode.disconnect(); } catch (e) {}
      state.screenDelayNode = null;
    }
    if (state.duckingGainNode) {
      try { state.duckingGainNode.disconnect(); } catch (e) {}
      state.duckingGainNode = null;
    }
    if (state.sourceNode) {
      try { state.sourceNode.disconnect(); } catch (e) {}
      state.sourceNode = null;
    }
    // Reset VU bar
    elements.vuBar.style.height = '0%';
    elements.visDbLevel.textContent = '-∞ dB';
    clearVisualizerCanvas();
  }

  // =========================================================================
  // 5. AUDIO VISUALIZER & VU METER
  // =========================================================================

  function clearVisualizerCanvas() {
    const canvas = elements.visualizerCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw baseline
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }

  function startVisualizer() {
    if (!elements.visualizerCanvas || !state.analyserNode) return;
    const canvas = elements.visualizerCanvas;
    const ctx = canvas.getContext('2d');
    const analyser = state.analyserNode;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = state.dataArray;

    function render() {
      state.animFrameId = requestAnimationFrame(render);
      analyser.getByteFrequencyData(dataArray);

      // Compute RMS / decibels
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const avg = sum / bufferLength;
      const pct = Math.min(100, Math.round((avg / 128) * 100));

      // Mini VU Meter on Pill
      elements.vuBar.style.height = `${pct}%`;
      if (pct > 75) {
        elements.vuBar.className = 'vu-bar clip';
      } else if (pct > 50) {
        elements.vuBar.className = 'vu-bar hot';
      } else {
        elements.vuBar.className = 'vu-bar';
      }

      // Decibel label
      const db = avg > 0 ? (20 * Math.log10(avg / 255)).toFixed(1) : '-∞';
      elements.visDbLevel.textContent = `${db} dB`;

      // Canvas Spectrum Visualizer
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.2;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height;
        
        // Neutral Swiss audio console styling (zinc tones with active white highlights)
        if (state.isDucked) {
          ctx.fillStyle = '#3f3f46'; // Dimmed while ducked
        } else if (dataArray[i] > 180) {
          ctx.fillStyle = '#e4e4e7';
        } else {
          ctx.fillStyle = '#71717a';
        }

        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }
    }

    render();
  }

  // =========================================================================
  // 5B. LOOKAHEAD LIP-SYNC VIDEO DELAY ENGINE
  // =========================================================================

  let lookaheadFrameQueue = [];
  let isLookaheadRunning = false;
  let lookaheadRafId = null;

  function startLookaheadVideoLoop() {
    if (!state.lookaheadSyncEnabled || !state.mediaStream) return;
    const videoTracks = state.mediaStream.getVideoTracks();
    if (!videoTracks || videoTracks.length === 0) return;

    const videoEl = elements.capturedVideoElement;
    const canvas = elements.lookaheadVideoCanvas;
    const badge = elements.lookaheadBadge;
    if (!videoEl || !canvas) return;

    try {
      videoEl.srcObject = new MediaStream([videoTracks[0]]);
      videoEl.play().catch(e => console.warn('Lookahead video element play error:', e));
    } catch (err) {
      console.warn('Lookahead video source attach error:', err);
      return;
    }

    canvas.style.display = 'block';
    if (badge) {
      badge.style.display = 'flex';
      if (elements.lookaheadBadgeText) {
        elements.lookaheadBadgeText.textContent = `Lookahead Lip-Sync: ${state.lookaheadDelay.toFixed(1)}s Delay`;
      }
    }

    isLookaheadRunning = true;
    lookaheadFrameQueue = [];
    const ctx = canvas.getContext('2d');

    let lastCaptureTime = 0;
    const targetFps = 30;
    const frameInterval = 1000 / targetFps;

    async function frameLoop(now) {
      if (!isLookaheadRunning) return;

      // 1. Capture live frame at 30 FPS
      if (now - lastCaptureTime >= frameInterval && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        lastCaptureTime = now;
        try {
          if (canvas.width !== videoEl.videoWidth || canvas.height !== videoEl.videoHeight) {
            canvas.width = videoEl.videoWidth;
            canvas.height = videoEl.videoHeight;
          }
          const bitmap = await createImageBitmap(videoEl);
          lookaheadFrameQueue.push({
            bitmap,
            timestamp: performance.now()
          });
        } catch (e) {}
      }

      // 2. Deliver frame delayed by state.lookaheadDelay seconds
      const delayMs = state.lookaheadDelay * 1000;
      const perfNow = performance.now();
      let readyFrame = null;

      while (lookaheadFrameQueue.length > 0 && (perfNow - lookaheadFrameQueue[0].timestamp) >= delayMs) {
        if (readyFrame) {
          readyFrame.bitmap.close();
        }
        readyFrame = lookaheadFrameQueue.shift();
      }

      if (readyFrame) {
        ctx.drawImage(readyFrame.bitmap, 0, 0, canvas.width, canvas.height);
        readyFrame.bitmap.close();
      }

      // Safety: prune queue to prevent GPU texture memory accumulation
      const maxQueueLength = Math.ceil(targetFps * (state.lookaheadDelay + 1.5));
      while (lookaheadFrameQueue.length > maxQueueLength) {
        const discarded = lookaheadFrameQueue.shift();
        if (discarded && discarded.bitmap) {
          try { discarded.bitmap.close(); } catch (e) {}
        }
      }

      lookaheadRafId = requestAnimationFrame(frameLoop);
    }

    lookaheadRafId = requestAnimationFrame(frameLoop);
  }

  function stopLookaheadVideoLoop() {
    isLookaheadRunning = false;
    if (lookaheadRafId) {
      cancelAnimationFrame(lookaheadRafId);
      lookaheadRafId = null;
    }

    if (lookaheadFrameQueue.length > 0) {
      for (const item of lookaheadFrameQueue) {
        if (item && item.bitmap) {
          try { item.bitmap.close(); } catch (e) {}
        }
      }
      lookaheadFrameQueue = [];
    }

    if (elements.capturedVideoElement) {
      try {
        elements.capturedVideoElement.pause();
        elements.capturedVideoElement.srcObject = null;
      } catch (e) {}
    }

    if (elements.lookaheadVideoCanvas) {
      elements.lookaheadVideoCanvas.style.display = 'none';
    }
    if (elements.lookaheadBadge) {
      elements.lookaheadBadge.style.display = 'none';
    }
  }

  // =========================================================================
  // 6. AUDIO CAPTURE: DISPLAY/SCREEN (DEFAULT) & MICROPHONE
  // =========================================================================

  async function startAudioCapture() {
    initAudioContext();

    const hasDisplay = hasDisplayMediaSupport();
    let isScreen = state.captureSource === 'display';

    // Guard: Mobile browsers do not support getDisplayMedia
    if (isScreen && !hasDisplay) {
      showToast('Mobile browsers do not support direct tab/screen capture. Switched to Microphone.', 'info', 5000);
      state.captureSource = 'mic';
      localStorage.setItem(STORAGE_KEYS.CAPTURE_SOURCE, 'mic');
      isScreen = false;
      if (elements.sourceMicRadio) elements.sourceMicRadio.checked = true;
      if (elements.sourceDisplayRadio) elements.sourceDisplayRadio.checked = false;
      if (elements.statSource) elements.statSource.innerHTML = 'Source: <strong>Mic (Mobile)</strong>';
    }

    try {
      let stream;
      if (isScreen) {
        // If running inside Capacitor Native Android APK
        const audioPlugin = getAudioCapturePlugin();
        if (isNativeAndroid() && audioPlugin) {
          showToast('Starting Android internal background dubbing engine...', 'info', 3000);
          const tCode = (state.tgtLang || 'fr').split('-')[0].toLowerCase();
          let chosenEngine = state.ttsEngine;
          if (!chosenEngine) {
            chosenEngine = (tCode === 'fr') ? 'mistral' : 'deepgram';
          }
          let chosenVoice = '';
          if (chosenEngine === 'mistral') {
            chosenVoice = state.mistralVoice || (tCode === 'fr' ? 'fr_marie_happy' : 'en_paul_happy');
          } else {
            const dgVoiceMap = {
              fr: 'aura-2-agathe-fr',
              de: 'aura-2-julius-de',
              es: 'aura-2-alvaro-es',
              ja: 'aura-2-ama-ja',
              it: 'aura-2-elio-it',
              nl: 'aura-2-lars-nl',
              en: 'aura-2-thalia-en'
            };
            chosenVoice = dgVoiceMap[tCode] || (tCode === 'fr' ? 'fr_marie_happy' : 'aura-2-thalia-en');
          }
          const captureOpts = {
            srcLang: state.srcLang || 'en',
            targetLang: state.tgtLang || 'fr',
            voice: chosenVoice,
            engine: chosenEngine
          };
          await audioPlugin.startScreenCapture(captureOpts);
          showToast('Background Dubber active! You can now switch to YouTube.', 'success', 5000);

          // Native Android Service sends live transcription & translation results
          audioPlugin.addListener('dubResult', (event) => {
            if (event && event.original && event.translated && state.isDubbing) {
              elements.liveOriginalTranscript.textContent = event.original;
              if (elements.liveTranslatedTranscript) {
                elements.liveTranslatedTranscript.textContent = event.translated;
              }
              updateTicker(`"${event.translated.slice(-35)}"`, 'listening');
              logTranscript(new Date().toLocaleTimeString(), event.original, event.translated);
            }
          });

          return null;
        }

        // Direct digital system/tab capture — with suppressLocalAudioPlayback to prevent browser double-playback echo!
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            suppressLocalAudioPlayback: true,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });

        // Ensure user actually shared audio
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
          showToast('Notice: Please check "Share audio" checkbox when selecting screen/tab.', 'error', 6000);
        } else {
          showToast('Direct Screen/Tab internal audio connected! Ready for YouTube.', 'success');
        }

        // Handle user clicking "Stop Sharing" on browser bar
        stream.getVideoTracks().forEach(track => {
          track.onended = () => {
            stopLookaheadVideoLoop();
            if (state.isDubbing) stopDubbing();
          };
        });
      } else {
        // Physical microphone / headset capture
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        showToast('Microphone / Headset audio connected.', 'success');
      }

      state.mediaStream = stream;
      setupAudioGraph(stream, isScreen);

      if (state.lookaheadSyncEnabled && isScreen) {
        startLookaheadVideoLoop();
      }

      return stream;
    } catch (err) {
      console.error('Audio capture permission error:', err);
      showToast(`Audio capture failed: ${err.message || 'Permission denied'}`, 'error');
      throw err;
    }
  }

  // =========================================================================
  // 7. REAL-TIME SPEECH RECOGNITION (STT) & INCREMENTAL CHUNKING
  // =========================================================================

  function setupSpeechRecognition() {
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      showToast('Web Speech API is not supported in this browser. Please use Google Chrome or Edge.', 'error');
      return null;
    }

    if (state.recognition) {
      try { state.recognition.abort(); } catch (e) {}
    }

    const recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = state.srcLang;
    recognition.maxAlternatives = 1;

    let localBuffer = '';

    recognition.onstart = () => {
      setStatus('listening');
      updateTicker('Listening for speech...', 'listening');
    };

    recognition.onresult = (event) => {
      let interim = '';
      let finalPhrase = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const item = event.results[i];
        if (item.isFinal) {
          finalPhrase += item[0].transcript;
        } else {
          interim += item[0].transcript;
        }
      }

      // Update live displays
      if (interim) {
        elements.liveOriginalTranscript.textContent = interim;
        updateTicker(`"${interim.slice(-40)}"`, 'listening');
      }

      // Sentence / clause boundary chunking: require complete final utterance or terminal punctuation with substantial content
      if (finalPhrase.trim()) {
        const cleaned = finalPhrase.trim();
        elements.liveOriginalTranscript.textContent = cleaned;
        dispatchUtteranceChunk(cleaned);
      } else if (interim.length > 55 && /[.?!]/.test(interim)) {
        const parts = interim.split(/([.?!])/);
        if (parts.length >= 3) {
          const chunk = (parts[0] + parts[1]).trim();
          if (chunk && chunk !== localBuffer && chunk.split(' ').length >= 6) {
            localBuffer = chunk;
            dispatchUtteranceChunk(chunk);
          }
        }
      }
    };

    recognition.onerror = (event) => {
      console.warn('SpeechRecognition error:', event.error);
      if (event.error === 'not-allowed' && state.captureSource === 'mic' && !document.hidden) {
        setStatus('error', 'Mic Blocked');
        showToast('Microphone access denied.', 'error');
      }
    };

    recognition.onend = () => {
      // Auto-restart if dubbing session is still active and using microphone
      if (state.isDubbing && state.captureSource === 'mic') {
        clearTimeout(state.recognitionRestartTimer);
        state.recognitionRestartTimer = setTimeout(() => {
          if (state.isDubbing && state.captureSource === 'mic') {
            try {
              recognition.start();
            } catch (e) {
              // Ignore if already active
            }
          }
        }, 300);
      } else {
        setStatus('idle');
      }
    };

    state.recognition = recognition;
    return recognition;
  }

  // =========================================================================
  // 8. REAL-TIME TRANSLATION (OpenRouter Free Models & Fallbacks)
  // =========================================================================

  function extractCleanTranslation(message, tgtLang) {
    if (!message) return null;
    let text = (message.content || '').trim();
    if (text) {
      text = text.replace(/^```[a-z]*\n|```$/gi, '').replace(/^["'`*]+|["'`*]+$/g, '').trim();
      if (text && !/^(the user|translate|welcome back to my youtube)/i.test(text)) {
        return text;
      }
    }

    // Inspect reasoning if content was null or wrapped
    const reasoning = (message.reasoning || '').trim();
    if (reasoning) {
      // Find quoted translations (e.g. "¡Bienvenido de vuelta a mi canal!")
      const quotes = [...reasoning.matchAll(/["“]([^"”\n]{2,120})["”]/g)];
      for (let i = quotes.length - 1; i >= 0; i--) {
        const q = quotes[i][1].trim();
        if (!/^(the user|user wants|welcome back|hello|today|analyze|this is)/i.test(q)) {
          return q;
        }
      }

      // Check last lines
      const lines = reasoning.split('\n').map(l => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].replace(/^[\*\-#>\d\.\s]+/, '').replace(/^["'`]+|["'`]+$/g, '').trim();
        if (line.length >= 2 && !/^(the user|user wants|let's|i will|analyze|translation|straightforward|note:|step\s*\d)/i.test(line)) {
          return line;
        }
      }
    }

    return text || null;
  }

  async function callOpenRouterCompletion(text, model, srcName, tgtName, apiKey) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5500);

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': window.location.origin || 'http://localhost:8080',
          'X-Title': 'Dubber Studio'
        },
        body: JSON.stringify({
          model: model,
          messages: [
            {
              role: 'system',
              content: `You are an ultra-fast simultaneous speech dubbing interpreter. Translate the spoken text from ${srcName} to ${tgtName}. Output ONLY the direct translated sentence in ${tgtName}. Do not provide explanations, notes, reasoning, or quotes.`
            },
            {
              role: 'user',
              content: text
            }
          ],
          temperature: 0.1,
          max_tokens: 120
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`OpenRouter HTTP ${response.status}`);
      }

      const data = await response.json();
      return extractCleanTranslation(data.choices?.[0]?.message, tgtName);
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  /**
   * Fast simultaneous translation via OpenRouter with cascading fallbacks
   */
  /**
   * High-accuracy, ultra-fast multi-tier real-time translation (Groq LPU Qwen 27B -> Cloudflare Edge AI -> Custom OpenRouter -> MyMemory -> Local)
   */
  async function translateText(text, srcLang, tgtLang) {
    if (!text || !text.trim()) return '';

    const apiKey = state.apiKey.trim();
    const srcName = getLanguageName(srcLang);
    const tgtName = getLanguageName(tgtLang);
    const sCode = (srcLang || 'en').split('-')[0].toLowerCase();
    const tCode = (tgtLang || 'fr').split('-')[0].toLowerCase();

    // 1. If user explicitly chose a custom OpenRouter model AND provided a custom API key, use OpenRouter first
    if (apiKey && state.model !== 'groq-server' && state.model !== 'cf-edge') {
      const primaryModel = state.model === 'custom' 
        ? (state.customModel.trim() || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free')
        : state.model;

      try {
        const result = await callOpenRouterCompletion(text, primaryModel, srcName, tgtName, apiKey);
        if (result && result.trim()) {
          return result.trim();
        }
      } catch (err) {
        console.warn(`Custom OpenRouter model ${primaryModel} failed (${err.message}), falling back to Groq LPU...`);
      }
    }

    // 2. High-speed Cloudflare Worker (Groq LPU Qwen 27B ~250-350ms, Zero API key required)
    try {
      const edgeUrl = `https://dubber.atmr.workers.dev/api/translate?text=${encodeURIComponent(text.trim())}&source=${sCode}&target=${tCode}`;
      const edgeRes = await fetch(edgeUrl);
      if (edgeRes.ok) {
        const data = await edgeRes.json();
        if (data && data.translatedText && data.translatedText.trim()) {
          return data.translatedText.trim();
        }
      }
    } catch (edgeErr) {
      console.warn('Groq/Cloudflare edge translation error, falling back to MyMemory:', edgeErr);
    }

    // 3. MyMemory Free API fallback (Zero API key required)
    try {
      const mmUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.trim())}&langpair=${sCode}|${tCode}`;
      const mmRes = await fetch(mmUrl);
      if (mmRes.ok) {
        const mmData = await mmRes.json();
        if (mmData && mmData.responseData && mmData.responseData.translatedText) {
          const txt = mmData.responseData.translatedText.trim();
          if (txt && !txt.startsWith('MYMEMORY WARNING')) {
            return txt;
          }
        }
      }
    } catch (mmErr) {
      console.warn('MyMemory translation error:', mmErr);
    }

    // 4. Local multilingual offline dictionary fallback
    return mockTranslate(text, tgtLang);
  }

  /**
   * Instant offline fallback dictionary for common expressions
   */
  function mockTranslate(text, tgtLang) {
    const tCode = tgtLang.split('-')[0].toLowerCase();
    const frDict = {
      'hello': 'bonjour',
      'welcome': 'bienvenue',
      'today': "aujourd'hui",
      'video': 'vidéo',
      'technology': 'technologie',
      'artificial intelligence': 'intelligence artificielle',
      'how are you': 'comment allez-vous',
      'thank you': 'merci',
      'dubber': 'Dubber'
    };
    const arDict = {
      'hello': 'مرحبا',
      'welcome': 'أهلا وسهلا',
      'today': 'اليوم',
      'video': 'فيديو',
      'technology': 'تكنولوجيا',
      'artificial intelligence': 'الذكاء الاصطناعي',
      'how are you': 'كيف حالك',
      'thank you': 'شكرا',
      'dubber': 'دبلر'
    };
    const esDict = {
      'hello': 'hola',
      'welcome': 'bienvenidos',
      'today': 'hoy',
      'video': 'video',
      'technology': 'tecnología',
      'artificial intelligence': 'inteligencia artificial',
      'how are you': 'cómo estás',
      'thank you': 'gracias',
      'dubber': 'Dubber'
    };

    const dict = tCode === 'fr' ? frDict : (tCode === 'ar' ? arDict : esDict);
    let res = text;
    for (const [en, trans] of Object.entries(dict)) {
      res = res.replace(new RegExp('\\b' + en + '\\b', 'gi'), trans);
    }
    return res;
  }

  function getLanguageName(code) {
    const langMap = {
      'en-US': 'English',
      'en-GB': 'English',
      'es-ES': 'Spanish',
      'es-MX': 'Spanish',
      'fr-FR': 'French',
      'de-DE': 'German',
      'ja-JP': 'Japanese',
      'zh-CN': 'Chinese',
      'ko-KR': 'Korean',
      'ar-SA': 'Arabic',
      'ru-RU': 'Russian',
      'pt-BR': 'Portuguese',
      'it-IT': 'Italian',
      'hi-IN': 'Hindi',
      'tr-TR': 'Turkish',
      'nl-NL': 'Dutch',
      'pl-PL': 'Polish',
      'id-ID': 'Indonesian',
      'vi-VN': 'Vietnamese'
    };
    return langMap[code] || code;
  }

  // =========================================================================
  // 9. INSTANT STREAMING PLAYBACK & GAPLESS AUDIO QUEUE (TTS)
  // =========================================================================

  /**
   * Handles an incoming speech chunk:
   * 1. Updates UI immediately
   * 2. Fires translation concurrently
   * 3. Feeds translation directly into the FIFO streaming playback queue
   */
  const HALLUCINATION_REGEXES = [
    /^\s*thank you[\s.!,]*$/i,
    /^\s*thanks for watching[\s.!,]*$/i,
    /^\s*thank you for watching[\s.!,]*$/i,
    /^\s*please subscribe[\s.!,]*$/i,
    /^\s*subscribe to (my|the) channel[\s.!,]*$/i,
    /^\s*bye[\s.!,]*$/i,
    /^\s*you[\s.!,]*$/i,
    /^\s*subtitles by[\s.!,]*$/i,
    /^\s*\[.*\]\s*$/i,
    /^\s*\(.*\)\s*$/i
  ];

  let lastDispatchedPhrase = '';
  let lastDispatchedTime = 0;

  /**
   * Handles an incoming speech chunk:
   * 1. Validates against Whisper/Nova-2 silence hallucinations
   * 2. Suppresses rapid duplicate repeats
   * 3. Translates text concurrently
   * 4. Feeds translation directly into the concurrent gapless audio pipeline
   */
  async function dispatchUtteranceChunk(originalText, captureCtxTime) {
    if (!originalText || !originalText.trim()) return;
    const text = originalText.trim();

    // 1. Anti-hallucination filter: discard Whisper/Nova-2 silence artifacts
    if (HALLUCINATION_REGEXES.some(rx => rx.test(text))) {
      return;
    }

    // 2. Anti-repetition filter: suppress rapid duplicate hallucinations within 6s
    const now = Date.now();
    if (text.toLowerCase() === lastDispatchedPhrase.toLowerCase() && (now - lastDispatchedTime < 6000)) {
      return;
    }
    lastDispatchedPhrase = text;
    lastDispatchedTime = now;

    setStatus('translating');
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    try {
      const translatedText = await translateText(text, state.srcLang, state.tgtLang);
      if (!translatedText || !translatedText.trim()) return;

      // Display in live stage
      elements.liveTranslatedTranscript.textContent = translatedText;
      updateTicker(`Dubbing: ${translatedText.slice(0, 50)}...`, 'dubbing');

      // Append to session log
      logTranscript(timestamp, text, translatedText);

      // Push into streaming pipelined audio queue with capture timestamp for lookahead sync
      enqueueAudioChunk(translatedText, captureCtxTime);
    } catch (err) {
      console.error('Error dispatching utterance chunk:', err);
      setStatus('error');
    }
  }

  // =========================================================================
  // 9. INSTANT STREAMING PLAYBACK & GAPLESS PIPELINED AUDIO ENGINE
  // =========================================================================

  let audioPipelineQueue = [];
  let isPipelinePlaying = false;
  let duckingReleaseTimer = null;
  let scheduledEndTime = 0;
  const activeUtterances = new Set();

  /**
   * Pre-fetch audio buffer concurrently while earlier chunks are still speaking
   */
  async function prefetchAudioBuffer(text) {
    const langPrefix = state.tgtLang.split('-')[0].toLowerCase();

    // 1. Mistral Voxtral (Ultra-Natural French and English Studio Neural TTS)
    if (state.ttsEngine === 'mistral') {
      if (langPrefix === 'fr' || langPrefix === 'en') {
        try {
          const url = 'https://dubber.atmr.workers.dev/api/mistral/tts';
          let chosenVoice = state.mistralVoice;
          if (!chosenVoice || (langPrefix === 'fr' && !chosenVoice.startsWith('fr_')) || (langPrefix === 'en' && !chosenVoice.startsWith('en_') && !chosenVoice.startsWith('gb_'))) {
            chosenVoice = langPrefix === 'fr' ? 'fr_marie_happy' : 'en_paul_happy';
          }
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: text,
              target: state.tgtLang,
              voice: chosenVoice
            })
          });

          if (res.ok) {
            const arrayBuffer = await res.arrayBuffer();
            const ctx = initAudioContext();
            if (ctx.state === 'suspended') await ctx.resume();
            return await ctx.decodeAudioData(arrayBuffer);
          }
        } catch (err) {
          console.warn('Mistral TTS prefetch failed, trying Deepgram fallback:', err.message);
        }
      }
      
      // For non-FR/EN languages (e.g. Spanish, German, Japanese), gracefully use Deepgram Aura-2
      if (langPrefix !== 'ar') {
        try {
          const dgUrl = 'https://dubber.atmr.workers.dev/api/deepgram/tts';
          const dgRes = await fetch(dgUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: text,
              target: state.tgtLang
            })
          });
          if (dgRes.ok) {
            const arrayBuffer = await dgRes.arrayBuffer();
            const ctx = initAudioContext();
            if (ctx.state === 'suspended') await ctx.resume();
            return await ctx.decodeAudioData(arrayBuffer);
          }
        } catch (dgErr) {
          console.warn('Deepgram fallback failed:', dgErr.message);
        }
      }
    }

    // 2. Deepgram Aura-2 (Ultra-fast, natively supports French, German, Spanish, English, Dutch, Italian, Japanese)
    // Deepgram Aura-2 does not support Arabic (ar)
    if (state.ttsEngine === 'deepgram' && langPrefix !== 'ar') {
      try {
        const url = 'https://dubber.atmr.workers.dev/api/deepgram/tts';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: text,
            target: state.tgtLang
          })
        });

        if (res.ok) {
          const arrayBuffer = await res.arrayBuffer();
          const ctx = initAudioContext();
          if (ctx.state === 'suspended') await ctx.resume();
          return await ctx.decodeAudioData(arrayBuffer);
        }
      } catch (err) {
        console.warn('Deepgram prefetch failed, will fallback:', err.message);
      }
    }

    // 2. OpenRouter Audio TTS if configured
    if (state.ttsEngine === 'openrouter' && state.apiKey) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${state.apiKey.trim()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: state.openRouterVoiceSlug || 'openai/tts-1',
            input: text,
            voice: 'alloy'
          })
        });

        if (res.ok) {
          const arrayBuffer = await res.arrayBuffer();
          const ctx = initAudioContext();
          if (ctx.state === 'suspended') await ctx.resume();
          return await ctx.decodeAudioData(arrayBuffer);
        }
      } catch (err) {
        console.warn('OpenRouter prefetch failed:', err.message);
      }
    }

    // Return null to signal SpeechSynthesis fallback (Arabic, offline, or default)
    return null;
  }

  /**
   * Enqueue translated text and immediately begin pre-fetching its audio in background
   */
  function enqueueAudioChunk(text, captureCtxTime) {
    if (!text || !text.trim()) return;

    const trimmed = text.trim();
    const item = {
      text: trimmed,
      captureCtxTime: captureCtxTime || (state.audioCtx ? state.audioCtx.currentTime : 0),
      fetchPromise: prefetchAudioBuffer(trimmed)
    };

    audioPipelineQueue.push(item);

    if (!isPipelinePlaying) {
      playAudioPipeline();
    }
  }

  /**
   * Continuous gapless audio playback coordinator with Web Audio clock scheduling
   */
  async function playAudioPipeline() {
    if (audioPipelineQueue.length === 0) {
      isPipelinePlaying = false;
      // DUCK RELEASE WITH HANG-TIME: don't pump volume up and down between conversational clauses!
      clearTimeout(duckingReleaseTimer);
      duckingReleaseTimer = setTimeout(() => {
        if (!isPipelinePlaying && audioPipelineQueue.length === 0) {
          applyDucking(false);
          setStatus(state.isDubbing ? 'listening' : 'idle');
        }
      }, 800);
      return;
    }

    isPipelinePlaying = true;
    clearTimeout(duckingReleaseTimer);
    applyDucking(true);
    setStatus('dubbing');

    const currentItem = audioPipelineQueue.shift();
    updateTicker(`Dubbing: ${currentItem.text.slice(0, 50)}...`, 'dubbing');

    try {
      // Await the pre-fetched audio buffer (which was already loading in background!)
      const audioBuffer = await currentItem.fetchPromise;

      if (audioBuffer) {
        const ctx = initAudioContext();
        if (ctx.state === 'suspended') await ctx.resume();

        const sourceNode = ctx.createBufferSource();
        sourceNode.buffer = audioBuffer;
        sourceNode.playbackRate.value = state.voiceRate;
        sourceNode.connect(ctx.destination);

        const now = ctx.currentTime;
        // Schedule next chunk seamlessly at the exact microsecond previous chunk finishes
        let startTime = Math.max(now, scheduledEndTime);

        // Lookahead Lip-Sync mode: synchronize dubbed TTS audio with the delayed canvas video frame!
        if (state.lookaheadSyncEnabled && currentItem.captureCtxTime) {
          const targetLipSyncTime = currentItem.captureCtxTime + state.lookaheadDelay;
          startTime = Math.max(startTime, targetLipSyncTime);
        }

        const duration = audioBuffer.duration / state.voiceRate;
        scheduledEndTime = startTime + duration;

        sourceNode.start(startTime);

        // Pre-schedule next chunk 40ms before this chunk finishes (gapless chaining)
        const delayMs = Math.max(10, ((startTime + duration) - ctx.currentTime - 0.04) * 1000);
        setTimeout(() => {
          playAudioPipeline();
        }, delayMs);

      } else {
        // SpeechSynthesis fallback (Arabic, offline, etc.)
        await playSpeechSynthesisPromise(currentItem.text);
        playAudioPipeline();
      }
    } catch (err) {
      console.warn('Pipeline playback error:', err);
      playAudioPipeline();
    }
  }

  /**
   * Native SpeechSynthesis Playback wrapped in a Promise
   */
  function playSpeechSynthesisPromise(text) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) {
        resolve();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = state.tgtLang;
      utterance.rate = state.voiceRate;
      utterance.pitch = state.voicePitch;

      // Pick configured voice if available
      const voices = window.speechSynthesis.getVoices();
      if (state.voiceUri) {
        const selected = voices.find(v => v.voiceURI === state.voiceUri);
        if (selected) utterance.voice = selected;
      } else {
        const langPrefix = state.tgtLang.split('-')[0].toLowerCase();
        const match = voices.find(v => {
          const vl = (v.lang || '').toLowerCase().replace('_', '-');
          return vl.startsWith(langPrefix);
        });
        if (match) utterance.voice = match;
      }

      activeUtterances.add(utterance);

      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        activeUtterances.delete(utterance);
        resolve();
      };

      const watchdog = setTimeout(done, Math.max(3500, text.length * 90));
      utterance.onend = done;
      utterance.onerror = done;

      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }

      window.speechSynthesis.speak(utterance);
    });
  }

  // =========================================================================
  // 10. SESSION TRANSCRIPT LOGGING & EXPORT
  // =========================================================================

  function logTranscript(time, original, translated) {
    state.transcripts.push({ time, original, translated });

    // Remove empty placeholder row
    const emptyRow = document.getElementById('emptyLogPrompt');
    if (emptyRow) emptyRow.remove();

    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="col-time">${time}</td>
      <td class="col-orig">${escapeHtml(original)}</td>
      <td class="col-trans">${escapeHtml(translated)}</td>
      <td class="col-action">
        <button type="button" class="btn btn-ghost btn-xs replay-btn" title="Replay Audio">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        </button>
      </td>
    `;

    row.querySelector('.replay-btn').addEventListener('click', () => {
      enqueueAudioChunk(translated);
    });

    elements.transcriptLogBody.prepend(row);
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function copyTranscriptToClipboard() {
    if (state.transcripts.length === 0) {
      showToast('No transcripts to copy yet.', 'info');
      return;
    }

    const text = state.transcripts
      .map(item => `[${item.time}]\nOriginal: ${item.original}\nDubbed: ${item.translated}\n`)
      .join('\n');

    navigator.clipboard.writeText(text).then(() => {
      showToast('Transcript copied to clipboard!', 'success');
    }).catch(err => {
      showToast('Failed to copy to clipboard', 'error');
    });
  }

  function downloadSrtSubtitles() {
    if (state.transcripts.length === 0) {
      showToast('No transcripts to export.', 'info');
      return;
    }

    let srt = '';
    state.transcripts.forEach((item, index) => {
      const idx = index + 1;
      const startSec = index * 4;
      const endSec = startSec + 3;
      const formatTime = (s) => {
        const h = String(Math.floor(s / 3600)).padStart(2, '0');
        const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        const sec = String(s % 60).padStart(2, '0');
        return `${h}:${m}:${sec},000`;
      };

      srt += `${idx}\n${formatTime(startSec)} --> ${formatTime(endSec)}\n${item.translated}\n\n`;
    });

    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dubber-subtitles-${Date.now()}.srt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('SRT Subtitle file downloaded.', 'success');
  }

  function clearTranscriptLog() {
    state.transcripts = [];
    elements.transcriptLogBody.innerHTML = `
      <tr class="empty-row" id="emptyLogPrompt">
        <td colspan="4">No spoken utterances recorded yet. Tap "Start Dub" or click a sample phrase above.</td>
      </tr>
    `;
    showToast('Transcript history cleared.', 'info');
  }

  // =========================================================================
  // 11. MASTER DUBBING LIFECYCLE (START / STOP)
  // =========================================================================

  async function startDubbing() {
    try {
      // 1. Start Audio Capture (Screen/Tab by default)
      await startAudioCapture();

      // 2. Setup STT ONLY if physical microphone was explicitly chosen
      // Screen/Tab and Android Internal Audio do NOT use SpeechRecognition!
      if (state.captureSource === 'mic') {
        const recognition = setupSpeechRecognition();
        if (recognition) {
          recognition.start();
        }
      } else {
        console.info('Dubber: Digital internal audio stream active. Hardware mic is isolated.');
      }

      state.isDubbing = true;
      elements.pillToggleBtn.classList.add('is-active');
      elements.pillToggleLabel.textContent = 'Stop Dub';
      elements.pillToggleIcon.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="6" width="12" height="12"/>
        </svg>
      `;

      setStatus('listening');
      updateTicker('Dubber active. Listening...', 'listening');
      showToast('Real-time dubbing started!', 'success');
    } catch (err) {
      console.error('Failed to start dubbing:', err);
      stopDubbing();
    }
  }

  function stopDubbing() {
    state.isDubbing = false;

    if (state.recognition) {
      try { state.recognition.stop(); } catch (e) {}
    }
    clearTimeout(state.recognitionRestartTimer);
    clearTimeout(duckingReleaseTimer);

    // Cancel queued TTS
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    audioPipelineQueue = [];
    isPipelinePlaying = false;
    scheduledEndTime = 0;

    // Restore source ducking gain
    applyDucking(false);

    // Stop streams
    stopAudioGraph();

    // If native Android screen capture was running, stop it
    const audioPlugin = getAudioCapturePlugin();
    if (isNativeAndroid() && audioPlugin) {
      try {
        audioPlugin.stopScreenCapture();
      } catch (e) {}
    }

    // Reset Pill
    elements.pillToggleBtn.classList.remove('is-active');
    elements.pillToggleLabel.textContent = 'Start Dub';
    elements.pillToggleIcon.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
    `;

    setStatus('idle');
    updateTicker('Dubber stopped. Ready.', 'normal');
  }

  function toggleDubbing() {
    if (state.isDubbing) {
      stopDubbing();
    } else {
      startDubbing();
    }
  }

  // =========================================================================
  // 12. DRAGGABLE FLOATING PILL BEHAVIOR
  // =========================================================================

  function initDraggablePill() {
    const pill = elements.floatingPill;
    const grip = elements.pillGrip;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    function applyDesktopPosition() {
      if (window.innerWidth > 640) {
        const savedPos = localStorage.getItem(STORAGE_KEYS.PILL_POS);
        if (savedPos) {
          try {
            const { left, top } = JSON.parse(savedPos);
            const maxLeft = window.innerWidth - pill.offsetWidth - 8;
            const maxTop = window.innerHeight - pill.offsetHeight - 8;
            pill.style.left = `${Math.max(8, Math.min(left, maxLeft))}px`;
            pill.style.top = `${Math.max(8, Math.min(top, maxTop))}px`;
            pill.style.right = 'auto';
            pill.style.bottom = 'auto';
          } catch (e) {}
        }
      } else {
        // Mobile view: clear inline styles completely so responsive bottom dock applies
        pill.style.left = '';
        pill.style.top = '';
        pill.style.right = '';
        pill.style.bottom = '';
      }
    }

    applyDesktopPosition();
    window.addEventListener('resize', applyDesktopPosition);

    function onPointerDown(e) {
      // Do not drag on mobile screens
      if (window.innerWidth <= 640) return;

      // Don't drag if clicking buttons inside pill
      if (e.target.closest('button:not(#pillGrip)') || e.target.closest('.pill-ticker')) {
        return;
      }

      isDragging = true;
      pill.classList.add('is-dragging');

      const rect = pill.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;

      pill.style.right = 'auto';
      pill.style.bottom = 'auto';
      pill.style.left = `${initialLeft}px`;
      pill.style.top = `${initialTop}px`;

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerUp);
    }

    function onPointerMove(e) {
      if (!isDragging) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      let newLeft = initialLeft + deltaX;
      let newTop = initialTop + deltaY;

      // Viewport bounds clamping
      const maxLeft = window.innerWidth - pill.offsetWidth - 8;
      const maxTop = window.innerHeight - pill.offsetHeight - 8;

      newLeft = Math.max(8, Math.min(newLeft, maxLeft));
      newTop = Math.max(8, Math.min(newTop, maxTop));

      pill.style.left = `${newLeft}px`;
      pill.style.top = `${newTop}px`;
    }

    function onPointerUp() {
      if (!isDragging) return;
      isDragging = false;
      pill.classList.remove('is-dragging');

      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);

      // Save position to localStorage on desktop
      if (window.innerWidth > 640) {
        const rect = pill.getBoundingClientRect();
        localStorage.setItem(STORAGE_KEYS.PILL_POS, JSON.stringify({ left: rect.left, top: rect.top }));
      }
    }

    if (grip) grip.addEventListener('pointerdown', onPointerDown);
    pill.addEventListener('pointerdown', (e) => {
      if (e.target === pill || e.target.classList.contains('pill-status')) {
        onPointerDown(e);
      }
    });
  }

  // =========================================================================
  // 13. SETTINGS DRAWER & VOICE POPULATION
  // =========================================================================

  function openDrawer() {
    elements.settingsDrawer.classList.add('is-open');
    elements.drawerBackdrop.classList.add('is-open');
    populateVoiceList();
  }

  function closeDrawer() {
    elements.settingsDrawer.classList.remove('is-open');
    elements.drawerBackdrop.classList.remove('is-open');
    saveSettingsFromDrawer();
  }

  function populateVoiceList() {
    if (!window.speechSynthesis) return;
    const voices = window.speechSynthesis.getVoices();
    elements.voiceSelect.innerHTML = '<option value="">Default System Voice</option>';

    const targetPrefix = state.tgtLang.split('-')[0].toLowerCase();
    
    // Group voices: Target language first
    const matching = [];
    const others = [];

    voices.forEach(voice => {
      const vl = (voice.lang || '').toLowerCase().replace('_', '-');
      if (vl.startsWith(targetPrefix)) {
        matching.push(voice);
      } else {
        others.push(voice);
      }
    });

    if (matching.length > 0) {
      const optGroup = document.createElement('optgroup');
      optGroup.label = `Voices for ${getLanguageName(state.tgtLang)}`;
      matching.forEach(voice => {
        const opt = document.createElement('option');
        opt.value = voice.voiceURI;
        opt.textContent = `${voice.name} (${voice.lang})`;
        if (voice.voiceURI === state.voiceUri) opt.selected = true;
        optGroup.appendChild(opt);
      });
      elements.voiceSelect.appendChild(optGroup);
    }

    if (others.length > 0) {
      const optGroup = document.createElement('optgroup');
      optGroup.label = 'Other System Voices';
      others.forEach(voice => {
        const opt = document.createElement('option');
        opt.value = voice.voiceURI;
        opt.textContent = `${voice.name} (${voice.lang})`;
        if (voice.voiceURI === state.voiceUri) opt.selected = true;
        optGroup.appendChild(opt);
      });
      elements.voiceSelect.appendChild(optGroup);
    }
  }

  function saveSettingsFromDrawer() {
    // Capture Source
    state.captureSource = elements.sourceDisplayRadio.checked ? 'display' : 'microphone';
    localStorage.setItem(STORAGE_KEYS.CAPTURE_SOURCE, state.captureSource);
    elements.statSource.innerHTML = `Source: <strong>${state.captureSource === 'display' ? 'Screen/Tab' : 'Mic'}</strong>`;

    // Loopback & Audio Routing
    state.micPassthrough = elements.micLoopbackToggle.checked;
    localStorage.setItem(STORAGE_KEYS.MIC_PASSTHROUGH, state.micPassthrough);
    if (elements.routeScreenToOutputToggle) {
      state.routeScreenToOutput = elements.routeScreenToOutputToggle.checked;
      localStorage.setItem(STORAGE_KEYS.ROUTE_SCREEN_TO_OUTPUT, state.routeScreenToOutput);
    }

    // Languages
    state.srcLang = elements.srcLangSelect.value;
    state.tgtLang = elements.tgtLangSelect.value;
    localStorage.setItem(STORAGE_KEYS.SRC_LANG, state.srcLang);
    localStorage.setItem(STORAGE_KEYS.TGT_LANG, state.tgtLang);

    elements.pillSrcBadge.textContent = state.srcLang.slice(0, 2).toUpperCase();
    elements.pillTgtBadge.textContent = state.tgtLang.slice(0, 2).toUpperCase();
    elements.labelSrcLang.textContent = getLanguageName(state.srcLang);
    elements.labelTgtLang.textContent = getLanguageName(state.tgtLang);

    // API Key
    state.apiKey = elements.openRouterKeyInput.value.trim();
    localStorage.setItem(STORAGE_KEYS.API_KEY, state.apiKey);
    updateKeyBadge();

    // Model
    state.model = elements.modelSelect.value;
    state.customModel = elements.customModelInput.value.trim();
    localStorage.setItem(STORAGE_KEYS.MODEL, state.model);
    localStorage.setItem(STORAGE_KEYS.CUSTOM_MODEL, state.customModel);

    state.ttsEngine = elements.ttsEngineSelect.value;
    if (elements.mistralVoiceSelect) {
      state.mistralVoice = elements.mistralVoiceSelect.value;
      localStorage.setItem('dubber_mistral_voice', state.mistralVoice);
    }
    state.voiceUri = elements.voiceSelect.value;
    state.voiceRate = parseFloat(elements.voiceRateSlider.value);
    state.voicePitch = parseFloat(elements.voicePitchSlider.value);
    if (elements.openRouterVoiceSlug) {
      state.openRouterVoiceSlug = elements.openRouterVoiceSlug.value.trim() || 'openai/tts-1';
      localStorage.setItem('dubber_or_voice_slug', state.openRouterVoiceSlug);
    }
    localStorage.setItem(STORAGE_KEYS.TTS_ENGINE, state.ttsEngine);
    localStorage.setItem(STORAGE_KEYS.VOICE_URI, state.voiceUri);
    localStorage.setItem(STORAGE_KEYS.VOICE_RATE, state.voiceRate);
    localStorage.setItem(STORAGE_KEYS.VOICE_PITCH, state.voicePitch);

    elements.statEngineVal.textContent = state.ttsEngine === 'mistral'
      ? 'Mistral Voxtral (FR/EN)'
      : (state.ttsEngine === 'deepgram' 
        ? 'Deepgram Aura-2 (<200ms)' 
        : (state.ttsEngine === 'speechSynthesis' ? 'SpeechSynth (Fast)' : 'OpenRouter TTS'));

    // Ducking
    state.duckingEnabled = elements.duckingEnabledCheck.checked;
    state.duckingDepth = parseInt(elements.duckingDepthSlider.value, 10);
    localStorage.setItem(STORAGE_KEYS.DUCKING_ENABLED, state.duckingEnabled);
    localStorage.setItem(STORAGE_KEYS.DUCKING_DEPTH, state.duckingDepth);
    elements.statDuckingVal.textContent = state.duckingEnabled ? `Active (${state.duckingDepth}%)` : 'Disabled';

    showToast('Settings saved.', 'info', 2000);
  }

  function updateKeyBadge() {
    if (state.apiKey) {
      elements.keyStatusBadge.className = 'badge badge-success';
      elements.keyStatusBadge.textContent = 'Custom Key Active';
    } else {
      elements.keyStatusBadge.className = 'badge badge-success';
      elements.keyStatusBadge.textContent = 'Groq Integrated';
    }
  }

  // Check for local credentials endpoint (from our local dev server)
  async function checkLocalCredentials() {
    try {
      const res = await fetch('/api/credentials');
      if (res.ok) {
        const data = await res.json();
        if (data.openrouter_api_key && !state.apiKey) {
          state.apiKey = data.openrouter_api_key;
          elements.openRouterKeyInput.value = state.apiKey;
          localStorage.setItem(STORAGE_KEYS.API_KEY, state.apiKey);
          updateKeyBadge();
        }
      }
    } catch (e) {
      // Static server without credentials endpoint
    }
    updateKeyBadge();
  }

  // =========================================================================
  // 14. EVENT LISTENERS & INITIALIZATION
  // =========================================================================

  function bindEvents() {
    // Pill Controls
    elements.pillToggleBtn.addEventListener('click', toggleDubbing);
    elements.openDrawerBtn.addEventListener('click', openDrawer);
    elements.headerSettingsBtn.addEventListener('click', openDrawer);
    elements.pillLangBadge.addEventListener('click', openDrawer);

    // Header Quick Test
    elements.headerTestSpeechBtn.addEventListener('click', () => {
      dispatchUtteranceChunk('Welcome to Dubber. Real-time video dubbing is working.');
    });

    // Drawer Controls
    elements.closeDrawerBtn.addEventListener('click', closeDrawer);
    elements.drawerBackdrop.addEventListener('click', closeDrawer);
    elements.saveDrawerBtn.addEventListener('click', closeDrawer);

    // Swap Languages
    elements.swapLangsBtn.addEventListener('click', () => {
      const currentSrc = elements.srcLangSelect.value;
      const currentTgt = elements.tgtLangSelect.value;
      const isSrcSupportedTarget = Array.from(elements.tgtLangSelect.options).some(opt => opt.value === currentSrc);
      if (isSrcSupportedTarget) {
        elements.srcLangSelect.value = currentTgt;
        elements.tgtLangSelect.value = currentSrc;
      } else {
        elements.srcLangSelect.value = currentTgt;
      }
      saveSettingsFromDrawer();
      populateVoiceList();
    });

    elements.srcLangSelect.addEventListener('change', () => {
      state.srcLang = elements.srcLangSelect.value;
      localStorage.setItem(STORAGE_KEYS.SRC_LANG, state.srcLang);
      elements.pillSrcBadge.textContent = state.srcLang.slice(0, 2).toUpperCase();
      elements.labelSrcLang.textContent = getLanguageName(state.srcLang);
    });

    elements.tgtLangSelect.addEventListener('change', () => {
      state.tgtLang = elements.tgtLangSelect.value;
      localStorage.setItem(STORAGE_KEYS.TGT_LANG, state.tgtLang);
      elements.pillTgtBadge.textContent = state.tgtLang.slice(0, 2).toUpperCase();
      elements.labelTgtLang.textContent = getLanguageName(state.tgtLang);

      // Default engine for French is Mistral Voxtral; for other supported languages, default to Deepgram Aura-2
      const tCode = state.tgtLang.split('-')[0].toLowerCase();
      if (tCode === 'fr') {
        elements.ttsEngineSelect.value = 'mistral';
        state.ttsEngine = 'mistral';
        localStorage.setItem(STORAGE_KEYS.TTS_ENGINE, 'mistral');
        if (elements.mistralVoiceGroup) elements.mistralVoiceGroup.classList.remove('hidden');
      } else if (elements.ttsEngineSelect.value === 'mistral') {
        elements.ttsEngineSelect.value = 'deepgram';
        state.ttsEngine = 'deepgram';
        localStorage.setItem(STORAGE_KEYS.TTS_ENGINE, 'deepgram');
        if (elements.mistralVoiceGroup) elements.mistralVoiceGroup.classList.add('hidden');
      }
      populateVoiceList();
    });

    // Key Visibility Toggle
    elements.toggleKeyVisibilityBtn.addEventListener('click', () => {
      const input = elements.openRouterKeyInput;
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    // Model Select
    elements.modelSelect.addEventListener('change', () => {
      if (elements.modelSelect.value === 'custom') {
        elements.customModelInput.classList.remove('hidden');
      } else {
        elements.customModelInput.classList.add('hidden');
      }
    });

    // TTS Engine Select
    elements.ttsEngineSelect.addEventListener('change', () => {
      const eng = elements.ttsEngineSelect.value;
      if (elements.mistralVoiceGroup) {
        elements.mistralVoiceGroup.classList.toggle('hidden', eng !== 'mistral');
      }
      elements.openRouterVoiceGroup.classList.toggle('hidden', eng !== 'openrouter');
      elements.speechSynthVoiceGroup.classList.toggle('hidden', eng !== 'speechSynthesis');
    });

    // Sliders
    elements.voiceRateSlider.addEventListener('input', () => {
      elements.voiceRateVal.textContent = `${parseFloat(elements.voiceRateSlider.value).toFixed(2)}x`;
    });
    elements.voicePitchSlider.addEventListener('input', () => {
      elements.voicePitchVal.textContent = `${parseFloat(elements.voicePitchSlider.value).toFixed(2)}x`;
    });
    elements.duckingDepthSlider.addEventListener('input', () => {
      const val = parseInt(elements.duckingDepthSlider.value, 10);
      const desc = val === 0 ? '0% (Total Mute -100%)' : `${val}% (-${100 - val}% duck)`;
      elements.duckingDepthVal.textContent = desc;
    });

    // Lookahead Lip-Sync Controls
    if (elements.lookaheadSyncToggle) {
      elements.lookaheadSyncToggle.addEventListener('change', () => {
        state.lookaheadSyncEnabled = elements.lookaheadSyncToggle.checked;
        localStorage.setItem(STORAGE_KEYS.LOOKAHEAD_SYNC_ENABLED, state.lookaheadSyncEnabled);
        if (elements.syncSliderGroup) {
          elements.syncSliderGroup.style.display = state.lookaheadSyncEnabled ? 'flex' : 'none';
        }
        if (state.isDubbing && state.captureSource === 'display') {
          if (state.lookaheadSyncEnabled) {
            startLookaheadVideoLoop();
          } else {
            stopLookaheadVideoLoop();
          }
        }
      });
    }

    if (elements.lookaheadDelaySlider) {
      elements.lookaheadDelaySlider.addEventListener('input', () => {
        state.lookaheadDelay = parseFloat(elements.lookaheadDelaySlider.value);
        if (elements.lookaheadDelayVal) {
          elements.lookaheadDelayVal.textContent = `${state.lookaheadDelay.toFixed(1)}s`;
        }
        if (elements.lookaheadBadgeText) {
          elements.lookaheadBadgeText.textContent = `Lookahead Lip-Sync: ${state.lookaheadDelay.toFixed(1)}s Delay`;
        }
        localStorage.setItem(STORAGE_KEYS.LOOKAHEAD_DELAY, state.lookaheadDelay);
        if (state.screenDelayNode && state.audioCtx) {
          state.screenDelayNode.delayTime.setValueAtTime(state.lookaheadDelay, state.audioCtx.currentTime);
        }
      });
    }

    if (elements.routeScreenToOutputToggle) {
      elements.routeScreenToOutputToggle.addEventListener('change', () => {
        state.routeScreenToOutput = elements.routeScreenToOutputToggle.checked;
        localStorage.setItem(STORAGE_KEYS.ROUTE_SCREEN_TO_OUTPUT, state.routeScreenToOutput);
      });
    }

    // Test Voice
    elements.testVoiceBtn.addEventListener('click', () => {
      const langPrefix = state.tgtLang.split('-')[0].toLowerCase();
      const testPhrase = langPrefix === 'fr'
        ? 'Bonjour, ceci est un test de synthèse vocale en temps réel.'
        : (langPrefix === 'es'
          ? 'Hola, esta es una prueba de voz doblada en tiempo real.'
          : (langPrefix === 'ar'
            ? 'مرحبا، هذا اختبار للصوت المدبلج في الوقت الفعلي.'
            : 'Hello, this is a test of real-time synthesized speech.'));
      enqueueAudioChunk(testPhrase);
    });

    // Test Translation Engine
    elements.testApiKeyBtn.addEventListener('click', async () => {
      const key = elements.openRouterKeyInput.value.trim();
      elements.testApiKeyBtn.disabled = true;
      elements.testApiKeyBtn.textContent = 'Testing...';

      if (key) {
        try {
          const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
            headers: { 'Authorization': `Bearer ${key}` }
          });
          if (res.ok) {
            showToast('OpenRouter API key is valid and connected!', 'success');
            elements.keyStatusBadge.className = 'badge badge-success';
            elements.keyStatusBadge.textContent = 'Key Verified';
          } else {
            showToast(`Invalid API Key (HTTP ${res.status})`, 'error');
          }
        } catch (err) {
          showToast('Connection failed. Check network or key.', 'error');
        } finally {
          elements.testApiKeyBtn.disabled = false;
          elements.testApiKeyBtn.textContent = 'Test Translation Engine';
        }
      } else {
        // Test integrated server-side Groq LPU engine
        try {
          const t0 = performance.now();
          const res = await fetch('https://dubber.atmr.workers.dev/api/translate?text=Hello+world&source=en&target=es');
          const dt = Math.round(performance.now() - t0);
          if (res.ok) {
            const data = await res.json();
            showToast(`Groq LPU Engine Active (~${dt}ms)! Output: "${data.translatedText}"`, 'success');
            elements.keyStatusBadge.className = 'badge badge-success';
            elements.keyStatusBadge.textContent = `Groq Active (${dt}ms)`;
          } else {
            showToast(`Engine test error (HTTP ${res.status})`, 'error');
          }
        } catch (err) {
          showToast('Could not reach translation server.', 'error');
        } finally {
          elements.testApiKeyBtn.disabled = false;
          elements.testApiKeyBtn.textContent = 'Test Translation Engine';
        }
      }
    });

    // Reset Defaults
    elements.resetDefaultsBtn.addEventListener('click', () => {
      elements.sourceDisplayRadio.checked = true;
      elements.srcLangSelect.value = 'en-US';
      elements.tgtLangSelect.value = 'fr-FR';
      elements.modelSelect.value = 'groq-server';
      elements.ttsEngineSelect.value = 'mistral';
      if (elements.mistralVoiceSelect) elements.mistralVoiceSelect.value = 'fr_marie_happy';
      if (elements.mistralVoiceGroup) elements.mistralVoiceGroup.classList.remove('hidden');
      elements.openRouterVoiceGroup.classList.add('hidden');
      elements.speechSynthVoiceGroup.classList.add('hidden');
      elements.voiceRateSlider.value = '1.1';
      elements.voiceRateVal.textContent = '1.10x';
      elements.voicePitchSlider.value = '1.0';
      elements.voicePitchVal.textContent = '1.00x';
      elements.duckingEnabledCheck.checked = true;
      elements.duckingDepthSlider.value = '20';
      elements.duckingDepthVal.textContent = '20% (-80% duck)';
      populateVoiceList();
      showToast('Settings reset to defaults.', 'info');
    });

    // Voices reload
    elements.refreshVoicesBtn.addEventListener('click', populateVoiceList);
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = populateVoiceList;
    }

    // YouTube Embed Loader
    elements.loadYoutubeBtn.addEventListener('click', () => {
      let url = elements.youtubeUrlInput.value.trim();
      if (!url) return;
      let videoId = url;
      // Match YouTube IDs
      const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
      if (match && match[1]) {
        videoId = match[1];
      }
      elements.youtubePlayer.src = `https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1&autoplay=1`;
      showToast('Loaded YouTube video.', 'success');
    });

    // Test Utterance sample buttons
    document.querySelectorAll('.test-utterance-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = btn.getAttribute('data-text');
        dispatchUtteranceChunk(text);
      });
    });

    // Transcript Actions
    elements.copyTranscriptBtn.addEventListener('click', copyTranscriptToClipboard);
    elements.downloadTranscriptBtn.addEventListener('click', downloadSrtSubtitles);
    elements.clearTranscriptBtn.addEventListener('click', clearTranscriptLog);

    // Keyboard Shortcuts (Space bar to toggle dub if not focused on inputs)
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
        e.preventDefault();
        toggleDubbing();
      } else if (e.code === 'Escape' && elements.settingsDrawer.classList.contains('is-open')) {
        closeDrawer();
      }
    });
  }

  function initUIFromState() {
    // Check display media capability on this device (Desktop vs Mobile vs Native Android)
    const hasDisplay = hasDisplayMediaSupport();
    if (isNativeAndroid()) {
      state.captureSource = 'display';
      localStorage.setItem(STORAGE_KEYS.CAPTURE_SOURCE, 'display');
      if (elements.sourceDisplayRadio) {
        elements.sourceDisplayRadio.checked = true;
        elements.sourceDisplayRadio.disabled = false;
        const parent = elements.sourceDisplayRadio.closest('.radio-card');
        if (parent) {
          parent.style.opacity = '1.0';
          const title = parent.querySelector('.radio-card-title');
          if (title) title.textContent = 'Internal Audio Capture (Android Service)';
          const desc = parent.querySelector('.radio-card-desc');
          if (desc) desc.textContent = 'Direct hardware playback capture. Dubs YouTube and apps in the background with zero echo.';
        }
      }
      if (elements.sourceMicRadio) {
        elements.sourceMicRadio.checked = false;
      }
      if (elements.statSource) {
        elements.statSource.innerHTML = 'Source: <strong>Internal Audio (Android Service)</strong>';
      }
    } else if (!hasDisplay) {
      state.captureSource = 'mic';
      if (elements.sourceDisplayRadio) {
        elements.sourceDisplayRadio.disabled = true;
        const parent = elements.sourceDisplayRadio.closest('.radio-card');
        if (parent) {
          parent.style.opacity = '0.55';
          const title = parent.querySelector('.radio-card-title');
          if (title && !title.textContent.includes('Desktop')) {
            title.textContent += ' (Desktop Only)';
          }
          const desc = parent.querySelector('.radio-card-desc');
          if (desc) {
            desc.textContent = 'Mobile web browsers restrict screen audio by OS security. Use Microphone mode or the In-App Video player below.';
          }
        }
      }
    }

    // Radio buttons
    if (state.captureSource === 'display' && hasDisplay) {
      elements.sourceDisplayRadio.checked = true;
    } else {
      elements.sourceMicRadio.checked = true;
    }
    elements.micLoopbackToggle.checked = state.micPassthrough;

    // Languages
    elements.srcLangSelect.value = state.srcLang;
    elements.tgtLangSelect.value = state.tgtLang;
    elements.pillSrcBadge.textContent = state.srcLang.slice(0, 2).toUpperCase();
    elements.pillTgtBadge.textContent = state.tgtLang.slice(0, 2).toUpperCase();
    elements.labelSrcLang.textContent = getLanguageName(state.srcLang);
    elements.labelTgtLang.textContent = getLanguageName(state.tgtLang);

    // API Key & Model
    elements.openRouterKeyInput.value = state.apiKey;
    if (state.model.includes('llama-3.2-3b') || state.model.includes('nemotron') || state.model === 'liquid/lfm-2.5-2.6b:free' || state.model === 'default') {
      state.model = 'groq-server';
      localStorage.setItem(STORAGE_KEYS.MODEL, state.model);
    }
    elements.modelSelect.value = state.model;
    if (state.model === 'custom') {
      elements.customModelInput.classList.remove('hidden');
      elements.customModelInput.value = state.customModel;
    }

    elements.ttsEngineSelect.value = state.ttsEngine;
    if (elements.mistralVoiceSelect) {
      elements.mistralVoiceSelect.value = state.mistralVoice;
    }
    if (elements.mistralVoiceGroup) {
      elements.mistralVoiceGroup.classList.toggle('hidden', state.ttsEngine !== 'mistral');
    }
    elements.openRouterVoiceGroup.classList.toggle('hidden', state.ttsEngine !== 'openrouter');
    elements.speechSynthVoiceGroup.classList.toggle('hidden', state.ttsEngine !== 'speechSynthesis');

    if (elements.openRouterVoiceSlug) {
      elements.openRouterVoiceSlug.value = state.openRouterVoiceSlug;
    }
    elements.voiceRateSlider.value = state.voiceRate;
    elements.voiceRateVal.textContent = `${state.voiceRate.toFixed(2)}x`;
    elements.voicePitchSlider.value = state.voicePitch;
    elements.voicePitchVal.textContent = `${state.voicePitch.toFixed(2)}x`;
    elements.duckingEnabledCheck.checked = state.duckingEnabled;
    elements.duckingDepthSlider.value = state.duckingDepth;
    const initialDepthDesc = state.duckingDepth === 0 ? '0% (Total Mute -100%)' : `${state.duckingDepth}% (-${100 - state.duckingDepth}% duck)`;
    elements.duckingDepthVal.textContent = initialDepthDesc;

    if (elements.routeScreenToOutputToggle) {
      elements.routeScreenToOutputToggle.checked = state.routeScreenToOutput;
    }
    if (elements.lookaheadSyncToggle) {
      elements.lookaheadSyncToggle.checked = state.lookaheadSyncEnabled;
    }
    if (elements.syncSliderGroup) {
      elements.syncSliderGroup.style.display = state.lookaheadSyncEnabled ? 'flex' : 'none';
    }
    if (elements.lookaheadDelaySlider) {
      elements.lookaheadDelaySlider.value = state.lookaheadDelay;
    }
    if (elements.lookaheadDelayVal) {
      elements.lookaheadDelayVal.textContent = `${state.lookaheadDelay.toFixed(1)}s`;
    }

    elements.statSource.innerHTML = `Source: <strong>${state.captureSource === 'display' ? 'Screen/Tab' : 'Mic'}</strong>`;
    elements.statEngineVal.textContent = state.ttsEngine === 'mistral'
      ? 'Mistral Voxtral (FR/EN)'
      : (state.ttsEngine === 'deepgram' 
        ? 'Deepgram Aura-2 (<200ms)' 
        : (state.ttsEngine === 'speechSynthesis' ? 'SpeechSynth (Fast)' : 'OpenRouter TTS'));
    elements.statDuckingVal.textContent = state.duckingEnabled ? `Active (${state.duckingDepth}%)` : 'Disabled';

    populateVoiceList();
    clearVisualizerCanvas();
  }

  // =========================================================================
  // 15. BOOTSTRAP
  // =========================================================================

  document.addEventListener('DOMContentLoaded', () => {
    initUIFromState();
    initDraggablePill();
    bindEvents();
    checkLocalCredentials();
    setStatus('idle');
    if (new URLSearchParams(window.location.search).has('drawer')) {
      setTimeout(openDrawer, 100);
    }
  });

})();
