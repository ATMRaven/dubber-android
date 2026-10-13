package com.dubber.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.IBinder;
import android.util.Base64;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import java.io.ByteArrayOutputStream;

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

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;

        String action = intent.getAction();
        if (ACTION_START.equals(action)) {
            startForegroundNotification();
            Intent resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA);
            if (resultData != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startAudioCapture(resultData);
            }
        } else if (ACTION_STOP.equals(action)) {
            stopAudioCapture();
            stopForeground(true);
            stopSelf();
        }

        return START_NOT_STICKY;
    }

    private void startForegroundNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Dubber Background Audio Service",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Running real-time internal speech capture and translation in background");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Dubber Active")
            .setContentText("Capturing and translating audio in background")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build();

        startForeground(NOTIFICATION_ID, notification);
    }

    private void startAudioCapture(Intent resultData) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;

        MediaProjectionManager projectionManager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (projectionManager == null) return;

        mediaProjection = projectionManager.getMediaProjection(android.app.Activity.RESULT_OK, resultData);
        if (mediaProjection == null) {
            Log.e(TAG, "MediaProjection was null");
            return;
        }

        AudioPlaybackCaptureConfiguration config = new AudioPlaybackCaptureConfiguration.Builder(mediaProjection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build();

        final int sampleRate = 16000;
        final int channelConfig = AudioFormat.CHANNEL_IN_MONO;
        final int audioFormat = AudioFormat.ENCODING_PCM_16BIT;
        int minBufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat);
        int bufferSize = Math.max(minBufferSize, 4096);

        try {
            audioRecord = new AudioRecord.Builder()
                .setAudioPlaybackCaptureConfig(config)
                .setAudioFormat(new AudioFormat.Builder()
                    .setEncoding(audioFormat)
                    .setSampleRate(sampleRate)
                    .setChannelMask(channelConfig)
                    .build())
                .setBufferSizeInBytes(bufferSize)
                .build();

            audioRecord.startRecording();
            isRecording = true;

            recordingThread = new Thread(() -> {
                byte[] buffer = new byte[bufferSize];
                while (isRecording && audioRecord != null) {
                    int read = audioRecord.read(buffer, 0, buffer.length);
                    if (read > 0 && sListener != null) {
                        byte[] chunk = new byte[read];
                        System.arraycopy(buffer, 0, chunk, 0, read);
                        sListener.onAudioChunk(chunk);
                    }
                }
            }, "Dubber-AudioCaptureThread");
            recordingThread.start();
            Log.i(TAG, "Internal AudioCapture started successfully at 16kHz Mono");
        } catch (SecurityException | IllegalArgumentException e) {
            Log.e(TAG, "Error initializing AudioRecord: " + e.getMessage(), e);
        }
    }

    private void stopAudioCapture() {
        isRecording = false;
        if (audioRecord != null) {
            try {
                audioRecord.stop();
                audioRecord.release();
            } catch (Exception ignored) {}
            audioRecord = null;
        }
        if (mediaProjection != null) {
            mediaProjection.stop();
            mediaProjection = null;
        }
        if (recordingThread != null) {
            recordingThread.interrupt();
            recordingThread = null;
        }
        Log.i(TAG, "Internal AudioCapture stopped");
    }

    @Override
    public void onDestroy() {
        stopAudioCapture();
        super.onDestroy();
    }
}
