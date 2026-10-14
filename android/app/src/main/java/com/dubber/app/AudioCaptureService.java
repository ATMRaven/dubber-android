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
import java.util.concurrent.TimeUnit;

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

    // Background Execution Engine
    private ExecutorService dubExecutor;
    private MediaPlayer mediaPlayer;
    private volatile boolean isPlayingDubbedAudio = false;
    private AudioFocusRequest nativeAudioFocusRequest = null;

    // Dubbing pipeline settings
    private String srcLang = "en";
    private String targetLang = "fr";
    private String voice = "fr_marie_happy";
    private String engine = "mistral";

    @Override
    public void onCreate() {
        super.onCreate();
        mainHandler = new Handler(Looper.getMainLooper());
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
                if (tLang != null && !tLang.isEmpty()) targetLang = tLang;
                String v = intent.getStringExtra("voice");
                if (v != null && !v.isEmpty()) voice = v;
                String eng = intent.getStringExtra("engine");
                if (eng != null && !eng.isEmpty()) engine = eng;

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

            final int sampleRate = 16000;
            final int channelConfig = AudioFormat.CHANNEL_IN_MONO;
            final int audioFormat = AudioFormat.ENCODING_PCM_16BIT;
            int minBufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat);
            int bufferSize = Math.max(minBufferSize, 4096);

            audioRecord = new AudioRecord.Builder()
                .setAudioPlaybackCaptureConfig(config)
                .setAudioFormat(new AudioFormat.Builder()
                    .setEncoding(audioFormat)
                    .setSampleRate(sampleRate)
                    .setChannelMask(channelConfig)
                    .build())
                .setBufferSizeInBytes(bufferSize)
                .build();

            if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "AudioRecord could not initialize. State=" + audioRecord.getState());
                return;
            }

            dubExecutor = Executors.newSingleThreadExecutor();
            audioRecord.startRecording();
            isRecording = true;

            recordingThread = new Thread(() -> {
                byte[] buffer = new byte[bufferSize];
                ByteArrayOutputStream speechBuffer = new ByteArrayOutputStream();
                boolean isSpeechActive = false;
                int silenceFrames = 0;

                // Native VAD thresholds: 16kHz 16-bit mono
                // buffer is ~4096 bytes = 2048 samples = 128ms
                final int SPEECH_THRESHOLD_RMS = 160;   // approx 0.005 RMS
                final int SILENCE_FRAMES_TRIGGER = 3;    // ~380ms pause
                final int MAX_SPEECH_BYTES = 48000;      // 1.5s max phrase chunk (rapid phrases)
                final int MIN_SPEECH_BYTES = 9600;       // 0.3s min phrase chunk

                while (isRecording && audioRecord != null) {
                    try {
                        int read = audioRecord.read(buffer, 0, buffer.length);
                        if (read <= 0) continue;

                        // Echo suppression: If Dubber is actively playing speech out of phone speakers, drop captured audio
                        if (isPlayingDubbedAudio) {
                            continue;
                        }

                        if (sListener != null) {
                            byte[] chunk = new byte[read];
                            System.arraycopy(buffer, 0, chunk, 0, read);
                            sListener.onAudioChunk(chunk);
                        }

                        // Compute RMS energy across the 128ms PCM window
                        long sum = 0;
                        for (int i = 0; i < read; i += 2) {
                            short sample = (short) ((buffer[i] & 0xFF) | (buffer[i + 1] << 8));
                            sum += sample * sample;
                        }
                        double rms = Math.sqrt((double) sum / (read / 2));

                        if (rms >= SPEECH_THRESHOLD_RMS) {
                            if (!isSpeechActive) {
                                isSpeechActive = true;
                                speechBuffer.reset();
                            }
                            silenceFrames = 0;
                            speechBuffer.write(buffer, 0, read);

                            // FORCED CUT: If continuous audio reaches 1.5 seconds, dispatch immediately!
                            if (speechBuffer.size() >= MAX_SPEECH_BYTES) {
                                byte[] chunk = speechBuffer.toByteArray();
                                speechBuffer.reset();
                                isSpeechActive = false;
                                dispatchToEdgeDubber(chunk);
                            }
                        } else if (isSpeechActive) {
                            speechBuffer.write(buffer, 0, read);
                            silenceFrames++;

                            if (silenceFrames >= SILENCE_FRAMES_TRIGGER || speechBuffer.size() >= MAX_SPEECH_BYTES) {
                                if (speechBuffer.size() >= MIN_SPEECH_BYTES) {
                                    byte[] chunk = speechBuffer.toByteArray();
                                    dispatchToEdgeDubber(chunk);
                                }
                                speechBuffer.reset();
                                isSpeechActive = false;
                                silenceFrames = 0;
                            }
                        }
                    } catch (Throwable t) {
                        Log.e(TAG, "Error in audio capture loop: " + t.getMessage());
                        break;
                    }
                }
            }, "Dubber-AudioCaptureThread");
            recordingThread.start();
            Log.i(TAG, "Internal AudioCapture running at 16kHz Mono with Native Background Dubbing");
        } catch (Throwable e) {
            Log.e(TAG, "Error initializing AudioPlaybackCapture: " + e.getMessage(), e);
        }
    }

    private void dispatchToEdgeDubber(byte[] pcmData) {
        if (dubExecutor == null || dubExecutor.isShutdown()) return;

        dubExecutor.submit(() -> {
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
                conn.setRequestProperty("User-Agent", "Dubber/1.3.4 (Android Mobile)");
                conn.setDoOutput(true);
                conn.setConnectTimeout(4000);
                conn.setReadTimeout(12000);

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(wavBytes);
                    os.flush();
                }

                int respCode = conn.getResponseCode();
                if (respCode == 204 || respCode != 200) {
                    return;
                }

                String origHeader = conn.getHeaderField("X-Original-Text");
                String transHeader = conn.getHeaderField("X-Translated-Text");
                String origText = origHeader != null ? URLDecoder.decode(origHeader, "UTF-8") : "";
                String transText = transHeader != null ? URLDecoder.decode(transHeader, "UTF-8") : "";

                // Write MP3 audio to temporary cache file
                File cacheFile = new File(getCacheDir(), "dub_current.mp3");
                try (InputStream is = conn.getInputStream(); FileOutputStream fos = new FileOutputStream(cacheFile)) {
                    byte[] tempBuf = new byte[4096];
                    int n;
                    while ((n = is.read(tempBuf)) != -1) {
                        fos.write(tempBuf, 0, n);
                    }
                }

                // Play the translated speech with native system audio focus ducking!
                playDubbedAudioFile(cacheFile, origText, transText);

            } catch (Throwable t) {
                Log.e(TAG, "Native dubbing dispatch error: " + t.getMessage(), t);
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private void playDubbedAudioFile(File audioFile, String origText, String transText) {
        try {
            requestNativeDuck();
            isPlayingDubbedAudio = true;

            if (sDubResultListener != null) {
                sDubResultListener.onDubResult(origText, transText);
            }

            CountDownLatch latch = new CountDownLatch(1);
            mainHandler.post(() -> {
                try {
                    if (mediaPlayer != null) {
                        try { mediaPlayer.stop(); mediaPlayer.release(); } catch (Throwable ignored) {}
                        mediaPlayer = null;
                    }
                    mediaPlayer = new MediaPlayer();
                    mediaPlayer.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build());
                    mediaPlayer.setDataSource(audioFile.getAbsolutePath());
                    mediaPlayer.setOnCompletionListener(mp -> {
                        abandonNativeDuck();
                        isPlayingDubbedAudio = false;
                        latch.countDown();
                    });
                    mediaPlayer.setOnErrorListener((mp, what, extra) -> {
                        abandonNativeDuck();
                        isPlayingDubbedAudio = false;
                        latch.countDown();
                        return true;
                    });
                    mediaPlayer.prepare();
                    mediaPlayer.start();
                } catch (Throwable t) {
                    Log.e(TAG, "MediaPlayer setup error: " + t.getMessage(), t);
                    abandonNativeDuck();
                    isPlayingDubbedAudio = false;
                    latch.countDown();
                }
            });

            // Sequential pacing: wait until audio finishes speaking before processing next chunk
            latch.await(15, TimeUnit.SECONDS);

        } catch (Throwable t) {
            Log.e(TAG, "playDubbedAudioFile error: " + t.getMessage(), t);
            abandonNativeDuck();
            isPlayingDubbedAudio = false;
        }
    }

    private void requestNativeDuck() {
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (nativeAudioFocusRequest == null) {
                    AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
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
        if (dubExecutor != null) {
            try { dubExecutor.shutdownNow(); } catch (Throwable ignored) {}
            dubExecutor = null;
        }
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
        super.onDestroy();
    }
}
