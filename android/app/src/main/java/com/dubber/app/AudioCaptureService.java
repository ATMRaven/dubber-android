package com.dubber.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;

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

    private MediaProjection mediaProjection;
    private AudioRecord audioRecord;
    private Thread recordingThread;
    private boolean isRecording = false;
    private Handler mainHandler;

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
                // Android 14 requirement: startForeground with FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION must occur FIRST
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
                .setContentTitle("Dubber Active")
                .setContentText("Capturing and translating audio in real time")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();

            // Android 14+ (API 34+) REQUIRES ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
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

            // Android 14+ (API 34+) requires registering a callback on MediaProjection before use
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

            // CRITICAL: Exclude Dubber's own process UID to prevent acoustic echo and feedback loops
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

            audioRecord.startRecording();
            isRecording = true;

            recordingThread = new Thread(() -> {
                byte[] buffer = new byte[bufferSize];
                while (isRecording && audioRecord != null) {
                    try {
                        int read = audioRecord.read(buffer, 0, buffer.length);
                        if (read > 0 && sListener != null) {
                            byte[] chunk = new byte[read];
                            System.arraycopy(buffer, 0, chunk, 0, read);
                            sListener.onAudioChunk(chunk);
                        }
                    } catch (Throwable t) {
                        Log.e(TAG, "Error in audio capture loop: " + t.getMessage());
                        break;
                    }
                }
            }, "Dubber-AudioCaptureThread");
            recordingThread.start();
            Log.i(TAG, "Internal AudioCapture started successfully at 16kHz Mono");
        } catch (Throwable e) {
            Log.e(TAG, "Error initializing AudioPlaybackCapture: " + e.getMessage(), e);
        }
    }

    private void stopAudioCapture() {
        isRecording = false;
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
