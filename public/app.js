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
    PILL_POS: 'dubber_pill_pos'
  };

  const hasDisplayMediaSupport = () => {
    if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) {
      return true; // Native Android APK with AudioPlaybackCapture supports internal screen audio!
    }
    return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
  };

  const state = {
    isDubbing: false,
    status: 'idle', // 'idle' | 'listening' | 'translating' | 'dubbing' | 'error'
    captureSource: (localStorage.getItem(STORAGE_KEYS.CAPTURE_SOURCE) === 'display' && !hasDisplayMediaSupport())
      ? 'mic'
      : (localStorage.getItem(STORAGE_KEYS.CAPTURE_SOURCE) || (hasDisplayMediaSupport() ? 'display' : 'mic')),
    micPassthrough: localStorage.getItem(STORAGE_KEYS.MIC_PASSTHROUGH) === 'true',
    
    // Languages
    srcLang: localStorage.getItem(STORAGE_KEYS.SRC_LANG) || 'en-US',
    tgtLang: localStorage.getItem(STORAGE_KEYS.TGT_LANG) || 'es-ES',

    // OpenRouter Settings
    apiKey: localStorage.getItem(STORAGE_KEYS.API_KEY) || '',
    model: localStorage.getItem(STORAGE_KEYS.MODEL) || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    customModel: localStorage.getItem(STORAGE_KEYS.CUSTOM_MODEL) || '',

    // TTS & Voice
    ttsEngine: localStorage.getItem(STORAGE_KEYS.TTS_ENGINE) || 'deepgram',
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
   * Smoothly duck or restore source audio gain
   */
  function applyDucking(duck) {
    if (!state.duckingEnabled || !state.duckingGainNode || !state.audioCtx) return;
    state.isDucked = duck;

    const ctx = state.audioCtx;
    const now = ctx.currentTime;
    const targetGain = duck ? (state.duckingDepth / 100) : 1.0;
    const rampTime = duck ? 0.12 : 0.28; // Rapid duck (120ms), smooth recovery (280ms)

    state.duckingGainNode.gain.cancelScheduledValues(now);
    state.duckingGainNode.gain.setValueAtTime(state.duckingGainNode.gain.value, now);
    state.duckingGainNode.gain.linearRampToValueAtTime(targetGain, now + rampTime);

    // Update Pill & Stats
    if (duck) {
      elements.statDuckingVal.textContent = `Ducking Active (${state.duckingDepth}%)`;
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

    state.sourceNode = ctx.createMediaStreamSource(stream);
    state.duckingGainNode = ctx.createGain();
    state.duckingGainNode.gain.setValueAtTime(1.0, ctx.currentTime);

    state.analyserNode = ctx.createAnalyser();
    state.analyserNode.fftSize = 256;
    state.dataArray = new Uint8Array(state.analyserNode.frequencyBinCount);

    state.sourceNode.connect(state.duckingGainNode);
    state.duckingGainNode.connect(state.analyserNode);

    // CRITICAL AUDIO ROUTING RULE:
    // If Screen/Tab internal audio is captured, ROUTE to destination so the user
    // can listen to the YouTube video through headphones/speakers while ducked!
    // If Microphone is captured, DO NOT route to destination by default to prevent howling acoustic feedback loop!
    if (isScreenAudio) {
      state.analyserNode.connect(ctx.destination);
    } else if (state.micPassthrough) {
      state.analyserNode.connect(ctx.destination);
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

    processor.onaudioprocess = (e) => {
      if (!state.isDubbing) return;
      const input = e.inputBuffer.getChannelData(0);

      // Compute RMS volume
      let sum = 0;
      for (let i = 0; i < input.length; i++) {
        sum += input[i] * input[i];
      }
      const rms = Math.sqrt(sum / input.length);

      const SPEECH_THRESHOLD = 0.009; // Catches spoken dialogue cleanly
      const SILENCE_FRAMES_TRIGGER = 10; // ~0.9s pause marks clause boundary
      const MAX_FRAMES_PER_CHUNK = 34;   // ~3.1s max phrase chunk for rapid response

      if (rms >= SPEECH_THRESHOLD) {
        if (!isSpeechActive) {
          isSpeechActive = true;
          setStatus('listening');
        }
        silenceFrames = 0;
        activeSpeechSamples.push(new Float32Array(input));
      } else if (isSpeechActive) {
        activeSpeechSamples.push(new Float32Array(input));
        silenceFrames++;

        if (silenceFrames >= SILENCE_FRAMES_TRIGGER || activeSpeechSamples.length >= MAX_FRAMES_PER_CHUNK) {
          dispatchDigitalAudioChunk();
        }
      }
    };

    state.sourceNode.connect(processor);
    // Silent output to keep processor active
    processor.connect(ctx.destination);
    state.digitalProcessorNode = processor;
  }

  function handleNativePcmChunk(base64Data) {
    try {
      const binaryStr = atob(base64Data);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768.0;
      }
      activeSpeechSamples.push(float32);
      if (activeSpeechSamples.length >= 8) {
        dispatchDigitalAudioChunk();
      }
    } catch (e) {
      console.warn('Native PCM chunk handling error:', e);
    }
  }

  async function dispatchDigitalAudioChunk() {
    if (activeSpeechSamples.length === 0 || isTranscribingChunk) return;

    let totalLength = 0;
    for (const chunk of activeSpeechSamples) totalLength += chunk.length;

    // Skip very brief acoustic noise (< 0.3s)
    if (totalLength < state.audioCtx.sampleRate * 0.3) {
      activeSpeechSamples = [];
      isSpeechActive = false;
      silenceFrames = 0;
      return;
    }

    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of activeSpeechSamples) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    activeSpeechSamples = [];
    isSpeechActive = false;
    silenceFrames = 0;

    const downsampled = downsampleBuffer(merged, state.audioCtx.sampleRate, 16000);
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
          elements.liveOriginalTranscript.textContent = phrase;
          updateTicker(`"${phrase.slice(-40)}"`, 'listening');
          dispatchUtteranceChunk(phrase);
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
    activeSpeechSamples = [];
    isSpeechActive = false;
    silenceFrames = 0;
    isTranscribingChunk = false;
  }

  function stopAudioGraph() {
    stopDigitalAudioChunker();

    if (state.animFrameId) {
      cancelAnimationFrame(state.animFrameId);
      state.animFrameId = null;
    }
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(track => track.stop());
      state.mediaStream = null;
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
        if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform() && window.Capacitor.Plugins && window.Capacitor.Plugins.AudioCapture) {
          showToast('Requesting Android internal screen audio capture...', 'info', 3000);
          await window.Capacitor.Plugins.AudioCapture.startScreenCapture();
          showToast('Direct internal YouTube audio connected via Android Service!', 'success');
          window.Capacitor.Plugins.AudioCapture.addListener('audioChunk', (event) => {
            if (event && event.data && state.isDubbing) {
              handleNativePcmChunk(event.data);
            }
          });
          return null;
        }

        // Direct digital system/tab capture — works seamlessly with YouTube on desktop
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
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

      // CRITICAL LATENCY & CHUNKING RULE:
      // Don't wait for paragraph-level silence. Check for clause/sentence boundaries!
      if (finalPhrase.trim()) {
        const cleaned = finalPhrase.trim();
        elements.liveOriginalTranscript.textContent = cleaned;
        dispatchUtteranceChunk(cleaned);
      } else if (interim.length > 25 && /[.,?!;]/.test(interim)) {
        // Early punctuation boundary detection in interim stream
        const parts = interim.split(/([.,?!;])/);
        if (parts.length >= 3) {
          const chunk = (parts[0] + parts[1]).trim();
          if (chunk && chunk !== localBuffer) {
            localBuffer = chunk;
            dispatchUtteranceChunk(chunk);
          }
        }
      }
    };

    recognition.onerror = (event) => {
      console.warn('SpeechRecognition error:', event.error);
      if (event.error === 'not-allowed') {
        setStatus('error', 'Mic Blocked');
        showToast('Microphone access denied.', 'error');
      }
    };

    recognition.onend = () => {
      // Auto-restart if dubbing session is still active
      if (state.isDubbing) {
        clearTimeout(state.recognitionRestartTimer);
        state.recognitionRestartTimer = setTimeout(() => {
          if (state.isDubbing) {
            try {
              recognition.start();
            } catch (e) {
              // Ignore if already active
            }
          }
        }, 150);
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
   * High-accuracy, free multi-tier real-time translation (OpenRouter -> Cloudflare Edge AI -> MyMemory -> Local)
   */
  async function translateText(text, srcLang, tgtLang) {
    if (!text || !text.trim()) return '';

    const apiKey = state.apiKey.trim();
    const srcName = getLanguageName(srcLang);
    const tgtName = getLanguageName(tgtLang);
    const sCode = (srcLang || 'en').split('-')[0].toLowerCase();
    const tCode = (tgtLang || 'fr').split('-')[0].toLowerCase();

    // 1. If OpenRouter API key provided, try OpenRouter first
    if (apiKey) {
      const primaryModel = state.model === 'custom' 
        ? (state.customModel.trim() || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free')
        : state.model;

      const candidateModels = [
        primaryModel,
        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
        'liquid/lfm-2.5-2.6b:free'
      ];
      const uniqueModels = [...new Set(candidateModels)];

      for (const m of uniqueModels) {
        try {
          const result = await callOpenRouterCompletion(text, m, srcName, tgtName, apiKey);
          if (result && result.trim()) {
            return result.trim();
          }
        } catch (err) {
          console.warn(`Model ${m} failed (${err.message}), trying backup...`);
        }
      }
    }

    // 2. High-speed Cloudflare Edge AI (Zero API key required: French, Arabic, Spanish, etc.)
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
      console.warn('Cloudflare edge translation error, falling back to MyMemory:', edgeErr);
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
  async function dispatchUtteranceChunk(originalText) {
    if (!originalText || originalText.trim().length === 0) return;

    setStatus('translating');
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    try {
      const translatedText = await translateText(originalText, state.srcLang, state.tgtLang);

      // Display in live stage
      elements.liveTranslatedTranscript.textContent = translatedText;
      updateTicker(`Dubbing: ${translatedText.slice(0, 50)}...`, 'dubbing');

      // Append to session log
      logTranscript(timestamp, originalText, translatedText);

      // Push into streaming audio queue
      enqueueAudioChunk(translatedText);
    } catch (err) {
      console.error('Error dispatching utterance chunk:', err);
      setStatus('error');
    }
  }

  /**
   * FIFO Audio Playback Queue
   * Plays the first available translated chunk instantly without waiting
   * for the entire stream, chaining subsequent chunks seamlessly.
   */
  function enqueueAudioChunk(text) {
    if (!text || !text.trim()) return;

    state.ttsQueue.push(text.trim());

    // If queue wasn't already actively playing, start immediately
    if (!state.isAudioPlaying) {
      processNextAudioChunk();
    }
  }

  function processNextAudioChunk() {
    if (state.ttsQueue.length === 0) {
      state.isAudioPlaying = false;
      // DUCK RELEASE: When audio queue drains, restore source background volume
      applyDucking(false);
      setStatus(state.isDubbing ? 'listening' : 'idle');
      return;
    }

    state.isAudioPlaying = true;
    const chunk = state.ttsQueue.shift();

    // DUCK ATTACK: Apply audio ducking instantly as soon as speech starts
    applyDucking(true);
    setStatus('dubbing');

    if (state.ttsEngine === 'deepgram') {
      playDeepgramAudioChunk(chunk);
    } else if (state.ttsEngine === 'speechSynthesis') {
      playSpeechSynthesisChunk(chunk);
    } else {
      playOpenRouterAudioChunk(chunk);
    }
  }

  /**
   * Deepgram Aura-2 High-Speed Speech Synthesis
   */
  async function playDeepgramAudioChunk(text) {
    const langPrefix = state.tgtLang.split('-')[0].toLowerCase();
    // Deepgram Aura-2 natively supports French (fr), German (de), Spanish (es), English (en), Dutch (nl), Italian (it), Japanese (ja)
    // For Arabic, fallback to SpeechSynthesis
    if (langPrefix === 'ar') {
      playSpeechSynthesisChunk(text);
      return;
    }

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

      if (!res.ok) {
        throw new Error(`Deepgram TTS HTTP ${res.status}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      const ctx = initAudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      const sourceNode = ctx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.playbackRate.value = state.voiceRate;
      sourceNode.connect(ctx.destination);

      sourceNode.onended = () => {
        processNextAudioChunk();
      };

      sourceNode.start(0);
    } catch (err) {
      console.warn('Deepgram TTS failed, falling back to SpeechSynthesis:', err.message);
      playSpeechSynthesisChunk(text);
    }
  }

  const activeUtterances = new Set();

  /**
   * Native SpeechSynthesis Playback (Instant, Zero Latency, 100% Free)
   */
  function playSpeechSynthesisChunk(text) {
    if (!window.speechSynthesis) {
      console.warn('SpeechSynthesis not supported');
      processNextAudioChunk();
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
      // Match best voice for target language (case-insensitive, normalized)
      const langPrefix = state.tgtLang.split('-')[0].toLowerCase();
      const match = voices.find(v => {
        const vl = (v.lang || '').toLowerCase().replace('_', '-');
        return vl.startsWith(langPrefix);
      });
      if (match) utterance.voice = match;
    }

    // Retain in memory to prevent Chrome Garbage Collection bug from swallowing callbacks
    activeUtterances.add(utterance);

    // Watchdog timer: Chrome speech synth occasionally stalls onend
    let timer = setTimeout(() => {
      activeUtterances.delete(utterance);
      processNextAudioChunk();
    }, Math.max(3500, text.length * 90));

    const finish = () => {
      clearTimeout(timer);
      activeUtterances.delete(utterance);
      processNextAudioChunk();
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    // Chrome bug workaround: resume if paused
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }

    window.speechSynthesis.speak(utterance);
  }

  /**
   * OpenRouter Audio / TTS Playback with fallback
   */
  async function playOpenRouterAudioChunk(text) {
    // If no API key or audio model fails, seamlessly fallback to SpeechSynthesis
    if (!state.apiKey) {
      playSpeechSynthesisChunk(text);
      return;
    }

    try {
      // OpenRouter Audio endpoint or fallback
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

      if (!res.ok) {
        throw new Error(`OpenRouter TTS HTTP ${res.status}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      const ctx = initAudioContext();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      const sourceNode = ctx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.playbackRate.value = state.voiceRate;

      sourceNode.connect(ctx.destination);
      sourceNode.onended = () => {
        processNextAudioChunk();
      };

      sourceNode.start(0);
    } catch (err) {
      console.warn('OpenRouter Audio TTS failed, falling back to SpeechSynthesis:', err.message);
      playSpeechSynthesisChunk(text);
    }
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

      // 2. Setup STT
      const recognition = setupSpeechRecognition();
      if (recognition) {
        recognition.start();
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

    // Cancel queued TTS
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    state.ttsQueue = [];
    state.isAudioPlaying = false;

    // Restore source ducking gain
    applyDucking(false);

    // Stop streams
    stopAudioGraph();

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

    // Loopback
    state.micPassthrough = elements.micLoopbackToggle.checked;
    localStorage.setItem(STORAGE_KEYS.MIC_PASSTHROUGH, state.micPassthrough);

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

    elements.statEngineVal.textContent = state.ttsEngine === 'deepgram' 
      ? 'Deepgram Aura-2 (<200ms)' 
      : (state.ttsEngine === 'speechSynthesis' ? 'SpeechSynth (Fast)' : 'OpenRouter TTS');

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
      elements.keyStatusBadge.textContent = 'Key Active';
    } else {
      elements.keyStatusBadge.className = 'badge badge-muted';
      elements.keyStatusBadge.textContent = 'Offline / Free Demo';
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
      elements.srcLangSelect.value = elements.tgtLangSelect.value;
      elements.tgtLangSelect.value = currentSrc;
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
      if (elements.ttsEngineSelect.value === 'openrouter') {
        elements.openRouterVoiceGroup.classList.remove('hidden');
        elements.speechSynthVoiceGroup.classList.add('hidden');
      } else if (elements.ttsEngineSelect.value === 'speechSynthesis') {
        elements.openRouterVoiceGroup.classList.add('hidden');
        elements.speechSynthVoiceGroup.classList.remove('hidden');
      } else {
        // Deepgram Aura-2
        elements.openRouterVoiceGroup.classList.add('hidden');
        elements.speechSynthVoiceGroup.classList.add('hidden');
      }
    });

    // Sliders
    elements.voiceRateSlider.addEventListener('input', () => {
      elements.voiceRateVal.textContent = `${parseFloat(elements.voiceRateSlider.value).toFixed(2)}x`;
    });
    elements.voicePitchSlider.addEventListener('input', () => {
      elements.voicePitchVal.textContent = `${parseFloat(elements.voicePitchSlider.value).toFixed(2)}x`;
    });
    elements.duckingDepthSlider.addEventListener('input', () => {
      elements.duckingDepthVal.textContent = `${elements.duckingDepthSlider.value}% (-${100 - elements.duckingDepthSlider.value}% duck)`;
    });

    // Test Voice
    elements.testVoiceBtn.addEventListener('click', () => {
      const testPhrase = state.tgtLang.startsWith('es') 
        ? 'Hola, esta es una prueba de voz doblada en tiempo real.'
        : 'Hello, this is a test of real-time synthesized speech.';
      enqueueAudioChunk(testPhrase);
    });

    // Test API Key
    elements.testApiKeyBtn.addEventListener('click', async () => {
      const key = elements.openRouterKeyInput.value.trim();
      if (!key) {
        showToast('Please enter an OpenRouter API key first.', 'error');
        return;
      }
      elements.testApiKeyBtn.disabled = true;
      elements.testApiKeyBtn.textContent = 'Testing...';

      try {
        const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
          headers: { 'Authorization': `Bearer ${key}` }
        });
        if (res.ok) {
          const info = await res.json();
          showToast('OpenRouter API key is valid and connected!', 'success');
          elements.keyStatusBadge.className = 'badge badge-success';
          elements.keyStatusBadge.textContent = 'Verified';
        } else {
          showToast(`Invalid API Key (HTTP ${res.status})`, 'error');
        }
      } catch (err) {
        showToast('Connection failed. Check network or key.', 'error');
      } finally {
        elements.testApiKeyBtn.disabled = false;
        elements.testApiKeyBtn.textContent = 'Test OpenRouter Connection';
      }
    });

    // Reset Defaults
    elements.resetDefaultsBtn.addEventListener('click', () => {
      elements.sourceDisplayRadio.checked = true;
      elements.srcLangSelect.value = 'en-US';
      elements.tgtLangSelect.value = 'es-ES';
      elements.modelSelect.value = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
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
    // Check display media capability on this device (Desktop vs Mobile)
    const hasDisplay = hasDisplayMediaSupport();
    if (!hasDisplay) {
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
    if (state.model.includes('llama-3.2-3b') || state.model === 'liquid/lfm-2.5-2.6b:free') {
      state.model = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
      localStorage.setItem(STORAGE_KEYS.MODEL, state.model);
    }
    elements.modelSelect.value = state.model;
    if (state.model === 'custom') {
      elements.customModelInput.classList.remove('hidden');
      elements.customModelInput.value = state.customModel;
    }

    elements.ttsEngineSelect.value = state.ttsEngine;
    if (elements.openRouterVoiceSlug) {
      elements.openRouterVoiceSlug.value = state.openRouterVoiceSlug;
    }
    elements.voiceRateSlider.value = state.voiceRate;
    elements.voiceRateVal.textContent = `${state.voiceRate.toFixed(2)}x`;
    elements.voicePitchSlider.value = state.voicePitch;
    elements.voicePitchVal.textContent = `${state.voicePitch.toFixed(2)}x`;
    elements.duckingEnabledCheck.checked = state.duckingEnabled;
    elements.duckingDepthSlider.value = state.duckingDepth;
    elements.duckingDepthVal.textContent = `${state.duckingDepth}% (-${100 - state.duckingDepth}% duck)`;

    elements.statSource.innerHTML = `Source: <strong>${state.captureSource === 'display' ? 'Screen/Tab' : 'Mic'}</strong>`;
    elements.statEngineVal.textContent = state.ttsEngine === 'speechSynthesis' ? 'SpeechSynth (Fast)' : 'OpenRouter TTS';
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
