package com.dubber.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.MediaPlayer;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.PriorityBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

public class AudioCaptureService extends Service {
    private static final String TAG = "DubberAudioService";
    private static final String CHANNEL_ID = "dubber_audio_capture_channel";
    private static final int NOTIFICATION_ID = 40401;

    public static final String ACTION_START = "ACTION_START";
    public static final String ACTION_STOP = "ACTION_STOP";
    public static final String EXTRA_RESULT_DATA = "EXTRA_RESULT_DATA";

    public interface AudioDataListener {
        void onAudioChunk(byte[] pcmData);
    }

    private static AudioDataListener sListener;
    public static void setAudioDataListener(AudioDataListener listener) {
        sListener = listener;
    }

    public interface DubResultListener {
        void onDubResult(String originalText, String translatedText);
    }

    private static DubResultListener sDubResultListener;
    public static void setDubResultListener(DubResultListener listener) {
        sDubResultListener = listener;
    }

    private MediaProjection mediaProjection;
    private AudioRecord audioRecord;
    private Thread recordingThread;
    private boolean isRecording = false;
    private Handler mainHandler;

    // Background Parallel Fetch + Sequential Gapless Playback Engine
    private ExecutorService networkExecutor;
    private ExecutorService playbackExecutor;
    private final PriorityBlockingQueue<DubQueueItem> playQueue = new PriorityBlockingQueue<>();
    private final AtomicLong chunkSequence = new AtomicLong(0);
    private volatile long nextPlaySequence = 0;
    private volatile boolean isPipelineActive = false;

    private static class DubQueueItem implements Comparable<DubQueueItem> {
        final long sequenceId;
        final File audioFile;
        final String origText;
        final String transText;
        final boolean isTombstone;
        final long timestampMs;

        DubQueueItem(long sequenceId, File audioFile, String origText, String transText, boolean isTombstone) {
            this.sequenceId = sequenceId;
            this.audioFile = audioFile;
            this.origText = origText;
            this.transText = transText;
            this.isTombstone = isTombstone;
            this.timestampMs = System.currentTimeMillis();
        }

        @Override
        public int compareTo(DubQueueItem o) {
            return Long.compare(this.sequenceId, o.sequenceId);
        }
    }

    private MediaPlayer mediaPlayer;
    private android.speech.tts.TextToSpeech systemTts;
    private volatile boolean isPlayingDubbedAudio = false;
    private AudioFocusRequest nativeAudioFocusRequest = null;

    // Dubbing pipeline settings (French default: Mistral Voxtral Marie)
    private String srcLang = "en";
    private String targetLang = "fr";
    private String voice = "fr_marie_happy";
    private String engine = "mistral";

    @Override
    public void onCreate() {
        super.onCreate();
        mainHandler = new Handler(Looper.getMainLooper());
        try {
            systemTts = new android.speech.tts.TextToSpeech(getApplicationContext(), status -> {
                if (status == android.speech.tts.TextToSpeech.SUCCESS && systemTts != null) {
                    try {
                        systemTts.setLanguage(new java.util.Locale(targetLang));
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                            systemTts.setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build());
                        }
                    } catch (Throwable ignored) {}
                }
            });
        } catch (Throwable t) {
            Log.w(TAG, "System TextToSpeech init error: " + t.getMessage());
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;

        try {
            String action = intent.getAction();
            if (ACTION_START.equals(action)) {
                // Read configuration passed from Capacitor UI
                String sLang = intent.getStringExtra("srcLang");
                if (sLang != null && !sLang.isEmpty()) srcLang = sLang;
                String tLang = intent.getStringExtra("targetLang");
                if (tLang != null && !tLang.isEmpty()) {
                    targetLang = tLang;
                    if (systemTts != null) {
                        try { systemTts.setLanguage(new java.util.Locale(targetLang)); } catch (Throwable ignored) {}
                    }
                }
                String eng = intent.getStringExtra("engine");
                if (eng != null && !eng.isEmpty()) {
                    engine = eng;
                } else {
                    if ("ar".equalsIgnoreCase(targetLang)) {
                        engine = "groq";
                    } else if ("fr".equalsIgnoreCase(targetLang)) {
                        engine = "mistral";
                    } else {
                        engine = "deepgram";
                    }
                }
                String v = intent.getStringExtra("voice");
                if (v != null && !v.isEmpty()) {
                    voice = v;
                } else {
                    if ("ar".equalsIgnoreCase(targetLang)) {
                        voice = "fahad";
                    } else if ("fr".equalsIgnoreCase(targetLang)) {
                        voice = "fr_marie_happy";
                    } else {
                        voice = "aura-2-agathe-fr";
                    }
                }

                // Android requirement: startForeground must occur first
                startForegroundNotification();

                Intent resultData;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent.class);
                } else {
                    resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA);
                }

                if (resultData != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startAudioCapture(resultData);
                } else {
                    Log.w(TAG, "AudioCaptureService started without valid resultData or API < Q");
                }
            } else if (ACTION_STOP.equals(action)) {
                stopAudioCapture();
                stopForeground(true);
                stopSelf();
            }
        } catch (Throwable t) {
            Log.e(TAG, "Unhandled exception in onStartCommand: " + t.getMessage(), t);
        }

        return START_NOT_STICKY;
    }

    private void startForegroundNotification() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Dubber Audio Capture",
                    NotificationManager.IMPORTANCE_LOW
                );
                channel.setDescription("Real-time speech capture and dubbing in background");
                NotificationManager manager = getSystemService(NotificationManager.class);
                if (manager != null) {
                    manager.createNotificationChannel(channel);
                }
            }

            Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Dubber Active (" + srcLang.toUpperCase() + " → " + targetLang.toUpperCase() + ")")
                .setContentText("Translating and dubbing screen audio in background")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Throwable t) {
            Log.e(TAG, "Failed to start foreground notification: " + t.getMessage(), t);
        }
    }

    private void startAudioCapture(Intent resultData) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;

        try {
            MediaProjectionManager projectionManager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            if (projectionManager == null) {
                Log.e(TAG, "MediaProjectionManager is null");
                return;
            }

            mediaProjection = projectionManager.getMediaProjection(android.app.Activity.RESULT_OK, resultData);
            if (mediaProjection == null) {
                Log.e(TAG, "MediaProjection token creation failed (null)");
                return;
            }

            mediaProjection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    super.onStop();
                    Log.i(TAG, "MediaProjection stopped by Android system");
                    stopAudioCapture();
                }
            }, mainHandler);

            AudioPlaybackCaptureConfiguration.Builder configBuilder = new AudioPlaybackCaptureConfiguration.Builder(mediaProjection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN);

            // Exclude Dubber's own process UID to prevent internal acoustic echo loops
            configBuilder.excludeUid(android.os.Process.myUid());

            AudioPlaybackCaptureConfiguration config = configBuilder.build();

            // Format negotiation: HALs for AudioPlaybackCapture frequently reject 16kHz mono.
            // Probe supported standard rates and channel configs (48k/44.1k Stereo -> Mono)
            int[][] candidates = new int[][] {
                { 48000, AudioFormat.CHANNEL_IN_STEREO },
                { 44100, AudioFormat.CHANNEL_IN_STEREO },
                { 16000, AudioFormat.CHANNEL_IN_MONO },
                { 48000, AudioFormat.CHANNEL_IN_MONO },
                { 44100, AudioFormat.CHANNEL_IN_MONO },
                { 16000, AudioFormat.CHANNEL_IN_STEREO }
            };

            AudioRecord record = null;
            int chosenSampleRate = 16000;
            int chosenChannelConfig = AudioFormat.CHANNEL_IN_MONO;
            int chosenBufferSize = 4096;

            for (int[] cand : candidates) {
                int rate = cand[0];
                int ch = cand[1];
                try {
                    int minBuf = AudioRecord.getMinBufferSize(rate, ch, AudioFormat.ENCODING_PCM_16BIT);
                    if (minBuf <= 0) continue;
                    int bufSize = Math.max(minBuf * 2, 4096);

                    AudioRecord testRecord = new AudioRecord.Builder()
                        .setAudioPlaybackCaptureConfig(config)
                        .setAudioFormat(new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(rate)
                            .setChannelMask(ch)
                            .build())
                        .setBufferSizeInBytes(bufSize)
                        .build();

                    if (testRecord.getState() == AudioRecord.STATE_INITIALIZED) {
                        record = testRecord;
                        chosenSampleRate = rate;
                        chosenChannelConfig = ch;
                        chosenBufferSize = bufSize;
                        Log.i(TAG, "AudioPlaybackCapture initialized at " + rate + "Hz, ch=" + ch + ", buf=" + bufSize);
                        break;
                    } else {
                        testRecord.release();
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "Failed format attempt for " + rate + "Hz: " + t.getMessage());
                }
            }

            if (record == null) {
                Log.e(TAG, "AudioPlaybackCapture could not initialize any audio format!");
                return;
            }

            audioRecord = record;
            networkExecutor = Executors.newFixedThreadPool(2);
            playbackExecutor = Executors.newSingleThreadExecutor();
            playQueue.clear();
            chunkSequence.set(0);
            nextPlaySequence = 0;
            isPipelineActive = true;
            startPlaybackLoop();

            audioRecord.startRecording();
            isRecording = true;

            final int captureRate = chosenSampleRate;
            final int captureChannels = (chosenChannelConfig == AudioFormat.CHANNEL_IN_STEREO) ? 2 : 1;
            final int readBufSize = chosenBufferSize;

            recordingThread = new Thread(() -> {
                byte[] rawBuffer = new byte[readBufSize];
                ByteArrayOutputStream speechBuffer = new ByteArrayOutputStream();
                boolean isSpeechActive = false;
                int silenceFrames = 0;

                // Sentence-level VAD thresholds: calibrated for natural complete sentences & noise rejection
                final int SPEECH_THRESHOLD_RMS = 240;       // Higher barrier: cleanly rejects ambient game rumble & background sound effects
                final int SILENCE_FRAMES_TRIGGER = 6;       // ~500ms true pause: commas/breaths will not cut the sentence in half!
                final int MIN_SPEECH_BYTES = 40000;         // ~1.25s min chunk (rejects 1-word splinters)
                final int MAX_SPEECH_BYTES = 144000;        // ~4.5s max phrase cut (prevents runaway buffer)

                while (isRecording && audioRecord != null) {
                    try {
                        int read = audioRecord.read(rawBuffer, 0, rawBuffer.length);
                        if (read <= 0) continue;

                        // 1. Downmix to mono short samples
                        int inputFrames = read / (2 * captureChannels);
                        if (inputFrames <= 0) continue;

                        short[] monoInput = new short[inputFrames];
                        if (captureChannels == 2) {
                            for (int i = 0; i < inputFrames; i++) {
                                int byteIdx = i * 4;
                                short left = (short) ((rawBuffer[byteIdx] & 0xFF) | (rawBuffer[byteIdx + 1] << 8));
                                short right = (short) ((rawBuffer[byteIdx + 2] & 0xFF) | (rawBuffer[byteIdx + 3] << 8));
                                monoInput[i] = (short) ((left + right) / 2);
                            }
                        } else {
                            for (int i = 0; i < inputFrames; i++) {
                                int byteIdx = i * 2;
                                monoInput[i] = (short) ((rawBuffer[byteIdx] & 0xFF) | (rawBuffer[byteIdx + 1] << 8));
                            }
                        }

                        // 2. High-quality decimation/resampling to 16,000 Hz Mono
                        short[] samples16k;
                        if (captureRate == 16000) {
                            samples16k = monoInput;
                        } else if (captureRate == 48000) {
                            int outFrames = inputFrames / 3;
                            samples16k = new short[outFrames];
                            for (int i = 0; i < outFrames; i++) {
                                int idx = i * 3;
                                samples16k[i] = (short) (((long) monoInput[idx] + monoInput[idx + 1] + monoInput[idx + 2]) / 3);
                            }
                        } else {
                            // Linear interpolation for 44.1kHz or other rates
                            double ratio = (double) captureRate / 16000.0;
                            int outFrames = (int) (inputFrames / ratio);
                            samples16k = new short[outFrames];
                            for (int i = 0; i < outFrames; i++) {
                                double srcPos = i * ratio;
                                int srcIndex = (int) srcPos;
                                double frac = srcPos - srcIndex;
                                if (srcIndex + 1 < inputFrames) {
                                    samples16k[i] = (short) (monoInput[srcIndex] * (1.0 - frac) + monoInput[srcIndex + 1] * frac);
                                } else if (srcIndex < inputFrames) {
                                    samples16k[i] = monoInput[srcIndex];
                                }
                            }
                        }

                        if (samples16k.length == 0) continue;

                        // 3. Convert 16k samples to bytes
                        byte[] pcm16k = new byte[samples16k.length * 2];
                        long sum = 0;
                        for (int i = 0; i < samples16k.length; i++) {
                            short s = samples16k[i];
                            pcm16k[i * 2] = (byte) (s & 0xFF);
                            pcm16k[i * 2 + 1] = (byte) ((s >> 8) & 0xFF);
                            sum += (long) s * s;
                        }

                        // Notify listener (e.g. for VU meter in JS)
                        if (sListener != null) {
                            sListener.onAudioChunk(pcm16k);
                        }

                        // 4. Compute RMS energy across the 16kHz window
                        double rms = Math.sqrt((double) sum / samples16k.length);

                        if (rms >= SPEECH_THRESHOLD_RMS) {
                            if (!isSpeechActive) {
                                isSpeechActive = true;
                                speechBuffer.reset();
                            }
                            silenceFrames = 0;
                            speechBuffer.write(pcm16k, 0, pcm16k.length);

                            // Forced cut: only if continuous monologue hits 4.5s max length
                            if (speechBuffer.size() >= MAX_SPEECH_BYTES) {
                                byte[] chunk = speechBuffer.toByteArray();
                                speechBuffer.reset();
                                isSpeechActive = false;
                                dispatchToEdgeDubber(chunk);
                            }
                        } else if (isSpeechActive) {
                            speechBuffer.write(pcm16k, 0, pcm16k.length);
                            silenceFrames++;

                            // Natural pause cut: triggers when speaker pauses for ~500ms AND has formed a real sentence (>= 1.25s)
                            if ((silenceFrames >= SILENCE_FRAMES_TRIGGER && speechBuffer.size() >= MIN_SPEECH_BYTES)
                                || speechBuffer.size() >= MAX_SPEECH_BYTES) {
                                byte[] chunk = speechBuffer.toByteArray();
                                speechBuffer.reset();
                                isSpeechActive = false;
                                silenceFrames = 0;
                                dispatchToEdgeDubber(chunk);
                            }
                        }
                    } catch (Throwable t) {
                        Log.e(TAG, "Error in audio capture loop: " + t.getMessage());
                        break;
                    }
                }
            }, "Dubber-AudioCaptureThread");
            recordingThread.start();
            Log.i(TAG, "Internal AudioCapture running: " + captureRate + "Hz -> 16kHz Mono Pipeline");
        } catch (Throwable e) {
            Log.e(TAG, "Error initializing AudioPlaybackCapture: " + e.getMessage(), e);
        }
    }

    private void dispatchToEdgeDubber(byte[] pcmData) {
        if (networkExecutor == null || networkExecutor.isShutdown()) return;

        final long seq = chunkSequence.getAndIncrement();

        networkExecutor.submit(() -> {
            HttpURLConnection conn = null;
            try {
                byte[] wavBytes = buildWavBytes(pcmData, 16000, 1, 16);
                String urlStr = "https://dubber.atmr.workers.dev/api/dub"
                    + "?src=" + URLEncoder.encode(srcLang, "UTF-8")
                    + "&target=" + URLEncoder.encode(targetLang, "UTF-8")
                    + "&voice=" + URLEncoder.encode(voice, "UTF-8")
                    + "&engine=" + URLEncoder.encode(engine, "UTF-8");

                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "audio/wav");
                conn.setRequestProperty("User-Agent", "Dubber/1.3.7 (Android Mobile)");
                conn.setDoOutput(true);
                conn.setConnectTimeout(4000);
                conn.setReadTimeout(12000);

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(wavBytes);
                    os.flush();
                }

                int respCode = conn.getResponseCode();
                if (respCode == 204 || respCode != 200) {
                    playQueue.add(new DubQueueItem(seq, null, "", "", true));
                    return;
                }

                String origHeader = conn.getHeaderField("X-Original-Text");
                String transHeader = conn.getHeaderField("X-Translated-Text");
                String origText = origHeader != null ? URLDecoder.decode(origHeader, "UTF-8") : "";
                String transText = transHeader != null ? URLDecoder.decode(transHeader, "UTF-8") : "";

                // Write MP3 audio to temporary cache file
                File cacheFile = File.createTempFile("dub_" + seq + "_", ".mp3", getCacheDir());
                try (InputStream is = conn.getInputStream(); FileOutputStream fos = new FileOutputStream(cacheFile)) {
                    byte[] tempBuf = new byte[4096];
                    int n;
                    while ((n = is.read(tempBuf)) != -1) {
                        fos.write(tempBuf, 0, n);
                    }
                }

                playQueue.add(new DubQueueItem(seq, cacheFile, origText, transText, false));

            } catch (Throwable t) {
                Log.e(TAG, "Native dubbing network error (seq=" + seq + "): " + t.getMessage());
                playQueue.add(new DubQueueItem(seq, null, "", "", true));
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private void startPlaybackLoop() {
        if (playbackExecutor == null || playbackExecutor.isShutdown()) return;

        playbackExecutor.submit(() -> {
            Log.i(TAG, "Gapless ordered playback loop started");
            while (isPipelineActive && !Thread.currentThread().isInterrupted()) {
                try {
                    DubQueueItem item = playQueue.poll(150, TimeUnit.MILLISECONDS);
                    if (item == null) continue;

                    // Future sequence arrived before expected sequence
                    if (item.sequenceId > nextPlaySequence) {
                        playQueue.add(item);
                        Thread.sleep(60);
                        if (System.currentTimeMillis() - item.timestampMs > 2500) {
                            Log.w(TAG, "Advancing nextPlaySequence from " + nextPlaySequence + " to " + item.sequenceId + " to prevent stall");
                            nextPlaySequence = item.sequenceId;
                        }
                        continue;
                    }

                    if (item.sequenceId < nextPlaySequence) {
                        if (item.audioFile != null) {
                            try { item.audioFile.delete(); } catch (Throwable ignored) {}
                        }
                        continue;
                    }

                    nextPlaySequence++;

                    if (item.isTombstone) {
                        continue;
                    }

                    if (System.currentTimeMillis() - item.timestampMs > 15000) {
                        Log.w(TAG, "Dropping stale dub chunk (seq=" + item.sequenceId + ") to prevent desync");
                        if (item.audioFile != null) {
                            try { item.audioFile.delete(); } catch (Throwable ignored) {}
                        }
                        continue;
                    }

                    playAudioItemSynchronous(item);

                } catch (InterruptedException ie) {
                    break;
                } catch (Throwable t) {
                    Log.e(TAG, "Error in playback loop: " + t.getMessage(), t);
                }
            }
            Log.i(TAG, "Gapless ordered playback loop finished");
        });
    }

    private void playAudioItemSynchronous(DubQueueItem item) {
        try {
            requestNativeDuck();
            isPlayingDubbedAudio = true;

            if (sDubResultListener != null) {
                sDubResultListener.onDubResult(item.origText, item.transText);
            }

            final CountDownLatch latch = new CountDownLatch(1);
            final int queuedAhead = playQueue.size();

            mainHandler.post(() -> {
                boolean playedWithMediaPlayer = false;
                try {
                    if (item.audioFile != null && item.audioFile.exists() && item.audioFile.length() > 500) {
                        if (mediaPlayer != null) {
                            try { mediaPlayer.stop(); mediaPlayer.release(); } catch (Throwable ignored) {}
                            mediaPlayer = null;
                        }
                        mediaPlayer = new MediaPlayer();
                        mediaPlayer.setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build());
                        mediaPlayer.setVolume(1.0f, 1.0f);

                        try (java.io.FileInputStream fis = new java.io.FileInputStream(item.audioFile)) {
                            mediaPlayer.setDataSource(fis.getFD());
                        }

                        // Natural studio quality playback at authentic 1.0x human pitch and cadence

                        mediaPlayer.setOnCompletionListener(mp -> {
                            if (playQueue.isEmpty()) {
                                abandonNativeDuck();
                                isPlayingDubbedAudio = false;
                            }
                            try { item.audioFile.delete(); } catch (Throwable ignored) {}
                            latch.countDown();
                        });

                        mediaPlayer.setOnErrorListener((mp, what, extra) -> {
                            Log.w(TAG, "MediaPlayer playback error (" + what + ", " + extra + "), falling back to System TTS");
                            playSystemTts(item.transText, latch);
                            try { item.audioFile.delete(); } catch (Throwable ignored) {}
                            return true;
                        });

                        mediaPlayer.prepare();
                        mediaPlayer.start();
                        playedWithMediaPlayer = true;
                    }
                } catch (Throwable t) {
                    Log.e(TAG, "MediaPlayer setup error: " + t.getMessage(), t);
                }

                if (!playedWithMediaPlayer) {
                    playSystemTts(item.transText, latch);
                    if (item.audioFile != null) {
                        try { item.audioFile.delete(); } catch (Throwable ignored) {}
                    }
                }
            });

            latch.await(15, TimeUnit.SECONDS);

        } catch (Throwable t) {
            Log.e(TAG, "playAudioItemSynchronous error: " + t.getMessage(), t);
            if (playQueue.isEmpty()) {
                abandonNativeDuck();
                isPlayingDubbedAudio = false;
            }
        }
    }

    private void playSystemTts(String text, CountDownLatch latch) {
        try {
            if (systemTts != null && text != null && !text.isEmpty()) {
                systemTts.setLanguage(new java.util.Locale(targetLang));
                systemTts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                    @Override public void onStart(String utteranceId) {}
                    @Override
                    public void onDone(String utteranceId) {
                        if (playQueue.isEmpty()) {
                            abandonNativeDuck();
                            isPlayingDubbedAudio = false;
                        }
                        if (latch != null) latch.countDown();
                    }
                    @Override
                    public void onError(String utteranceId) {
                        if (playQueue.isEmpty()) {
                            abandonNativeDuck();
                            isPlayingDubbedAudio = false;
                        }
                        if (latch != null) latch.countDown();
                    }
                });
                systemTts.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "dub_phrase_" + System.currentTimeMillis());
            } else {
                if (playQueue.isEmpty()) {
                    abandonNativeDuck();
                    isPlayingDubbedAudio = false;
                }
                if (latch != null) latch.countDown();
            }
        } catch (Throwable t) {
            Log.e(TAG, "playSystemTts error: " + t.getMessage());
            if (playQueue.isEmpty()) {
                abandonNativeDuck();
                isPlayingDubbedAudio = false;
            }
            if (latch != null) latch.countDown();
        }
    }

    private void requestNativeDuck() {
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (nativeAudioFocusRequest == null) {
                    AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build();
                    nativeAudioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                        .setAudioAttributes(attrs)
                        .setAcceptsDelayedFocusGain(false)
                        .setWillPauseWhenDucked(false)
                        .build();
                }
                am.requestAudioFocus(nativeAudioFocusRequest);
            } else {
                am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
            }
        } catch (Throwable t) {
            Log.e(TAG, "requestNativeDuck error: " + t.getMessage());
        }
    }

    private void abandonNativeDuck() {
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nativeAudioFocusRequest != null) {
                am.abandonAudioFocusRequest(nativeAudioFocusRequest);
            } else {
                am.abandonAudioFocus(null);
            }
        } catch (Throwable t) {
            Log.e(TAG, "abandonNativeDuck error: " + t.getMessage());
        }
    }

    private byte[] buildWavBytes(byte[] pcmData, int sampleRate, int channels, int bitsPerSample) {
        int totalDataLen = pcmData.length + 36;
        int byteRate = sampleRate * channels * (bitsPerSample / 8);
        byte[] header = new byte[44];
        header[0] = 'R'; header[1] = 'I'; header[2] = 'F'; header[3] = 'F';
        header[4] = (byte) (totalDataLen & 0xff);
        header[5] = (byte) ((totalDataLen >> 8) & 0xff);
        header[6] = (byte) ((totalDataLen >> 16) & 0xff);
        header[7] = (byte) ((totalDataLen >> 24) & 0xff);
        header[8] = 'W'; header[9] = 'A'; header[10] = 'V'; header[11] = 'E';
        header[12] = 'f'; header[13] = 'm'; header[14] = 't'; header[15] = ' ';
        header[16] = 16; header[17] = 0; header[18] = 0; header[19] = 0;
        header[20] = 1; header[21] = 0;
        header[22] = (byte) channels; header[23] = 0;
        header[24] = (byte) (sampleRate & 0xff);
        header[25] = (byte) ((sampleRate >> 8) & 0xff);
        header[26] = (byte) ((sampleRate >> 16) & 0xff);
        header[27] = (byte) ((sampleRate >> 24) & 0xff);
        header[28] = (byte) (byteRate & 0xff);
        header[29] = (byte) ((byteRate >> 8) & 0xff);
        header[30] = (byte) ((byteRate >> 16) & 0xff);
        header[31] = (byte) ((byteRate >> 24) & 0xff);
        header[32] = (byte) (channels * (bitsPerSample / 8)); header[33] = 0;
        header[34] = (byte) bitsPerSample; header[35] = 0;
        header[36] = 'd'; header[37] = 'a'; header[38] = 't'; header[39] = 'a';
        header[40] = (byte) (pcmData.length & 0xff);
        header[41] = (byte) ((pcmData.length >> 8) & 0xff);
        header[42] = (byte) ((pcmData.length >> 16) & 0xff);
        header[43] = (byte) ((pcmData.length >> 24) & 0xff);

        byte[] wav = new byte[header.length + pcmData.length];
        System.arraycopy(header, 0, wav, 0, header.length);
        System.arraycopy(pcmData, 0, wav, header.length, pcmData.length);
        return wav;
    }

    private void stopAudioCapture() {
        isRecording = false;
        isPipelineActive = false;
        if (networkExecutor != null) {
            try { networkExecutor.shutdownNow(); } catch (Throwable ignored) {}
            networkExecutor = null;
        }
        if (playbackExecutor != null) {
            try { playbackExecutor.shutdownNow(); } catch (Throwable ignored) {}
            playbackExecutor = null;
        }
        for (DubQueueItem item : playQueue) {
            if (item.audioFile != null) {
                try { item.audioFile.delete(); } catch (Throwable ignored) {}
            }
        }
        playQueue.clear();

        if (mediaPlayer != null) {
            try { mediaPlayer.stop(); mediaPlayer.release(); } catch (Throwable ignored) {}
            mediaPlayer = null;
        }
        abandonNativeDuck();
        isPlayingDubbedAudio = false;

        if (audioRecord != null) {
            try {
                audioRecord.stop();
                audioRecord.release();
            } catch (Throwable ignored) {}
            audioRecord = null;
        }
        if (mediaProjection != null) {
            try {
                mediaProjection.stop();
            } catch (Throwable ignored) {}
            mediaProjection = null;
        }
        if (recordingThread != null) {
            try {
                recordingThread.interrupt();
            } catch (Throwable ignored) {}
            recordingThread = null;
        }
        Log.i(TAG, "Internal AudioCapture stopped cleanly");
    }

    @Override
    public void onDestroy() {
        stopAudioCapture();
        if (systemTts != null) {
            try { systemTts.stop(); systemTts.shutdown(); } catch (Throwable ignored) {}
            systemTts = null;
        }
        super.onDestroy();
    }
}
