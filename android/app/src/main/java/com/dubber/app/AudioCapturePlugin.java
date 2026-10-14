package com.dubber.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "AudioCapture",
    permissions = {
        @Permission(
            alias = "audio",
            strings = {
                Manifest.permission.RECORD_AUDIO
            }
        )
    }
)
public class AudioCapturePlugin extends Plugin {
    private static final String TAG = "AudioCapturePlugin";
    private AudioFocusRequest audioFocusRequest = null;

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q);
        ret.put("apiLevel", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    /**
     * Request system-level audio ducking on Android.
     * Tells external apps (like YouTube, Spotify, video players) to smoothly lower their volume.
     */
    @PluginMethod
    public void requestDuck(PluginCall call) {
        try {
            AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (audioManager == null) {
                call.reject("AudioManager not available");
                return;
            }

            int result;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (audioFocusRequest == null) {
                    AudioAttributes playbackAttributes = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build();

                    audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                        .setAudioAttributes(playbackAttributes)
                        .setAcceptsDelayedFocusGain(false)
                        .setWillPauseWhenDucked(false)
                        .build();
                }
                result = audioManager.requestAudioFocus(audioFocusRequest);
            } else {
                result = audioManager.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
            }

            JSObject ret = new JSObject();
            ret.put("ducked", result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
            call.resolve(ret);
        } catch (Throwable t) {
            Log.e(TAG, "Error in requestDuck: " + t.getMessage(), t);
            call.reject("requestDuck failed: " + t.getMessage());
        }
    }

    /**
     * Abandon system-level audio focus, restoring external apps to full 100% volume.
     */
    @PluginMethod
    public void abandonDuck(PluginCall call) {
        try {
            AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (audioManager != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
                    audioManager.abandonAudioFocusRequest(audioFocusRequest);
                } else {
                    audioManager.abandonAudioFocus(null);
                }
            }
            JSObject ret = new JSObject();
            ret.put("abandoned", true);
            call.resolve(ret);
        } catch (Throwable t) {
            Log.e(TAG, "Error in abandonDuck: " + t.getMessage(), t);
            call.reject("abandonDuck failed: " + t.getMessage());
        }
    }

    private String mSrcLang = "en";
    private String mTargetLang = "fr";
    private String mVoice = "fr_marie_happy";
    private String mEngine = "mistral";

    @PluginMethod
    public void startScreenCapture(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Android 10 (API 29) or higher is required for internal audio capture");
            return;
        }

        mSrcLang = call.getString("srcLang", "en");
        mTargetLang = call.getString("targetLang", "fr");
        mVoice = call.getString("voice", "fr_marie_happy");
        mEngine = call.getString("engine", "mistral");

        if (getPermissionState("audio") != PermissionState.GRANTED) {
            requestPermissionForAlias("audio", call, "audioPermCallback");
            return;
        }

        proceedScreenCapture(call);
    }

    @PermissionCallback
    private void audioPermCallback(PluginCall call) {
        if (getPermissionState("audio") == PermissionState.GRANTED) {
            proceedScreenCapture(call);
        } else {
            call.reject("Audio recording permission is required to capture internal playback audio");
        }
    }

    private void proceedScreenCapture(PluginCall call) {
        try {
            MediaProjectionManager projectionManager = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            if (projectionManager == null) {
                call.reject("MediaProjectionManager not available on this device");
                return;
            }

            AudioCaptureService.setAudioDataListener(pcmData -> {
                try {
                    String base64 = Base64.encodeToString(pcmData, Base64.NO_WRAP);
                    JSObject data = new JSObject();
                    data.put("data", base64);
                    data.put("size", pcmData.length);
                    notifyListeners("audioChunk", data);
                } catch (Throwable t) {
                    Log.e(TAG, "Error emitting audioChunk: " + t.getMessage());
                }
            });

            AudioCaptureService.setDubResultListener((orig, trans) -> {
                try {
                    JSObject data = new JSObject();
                    data.put("original", orig);
                    data.put("translated", trans);
                    notifyListeners("dubResult", data);
                } catch (Throwable t) {
                    Log.e(TAG, "Error emitting dubResult: " + t.getMessage());
                }
            });

            Intent captureIntent = projectionManager.createScreenCaptureIntent();
            startActivityForResult(call, captureIntent, "mediaProjectionCallback");
        } catch (Throwable t) {
            Log.e(TAG, "Error starting screen capture: " + t.getMessage(), t);
            call.reject("Failed to initiate screen capture: " + t.getMessage());
        }
    }

    @ActivityCallback
    private void mediaProjectionCallback(PluginCall call, ActivityResult result) {
        try {
            if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
                Intent serviceIntent = new Intent(getContext(), AudioCaptureService.class);
                serviceIntent.setAction(AudioCaptureService.ACTION_START);
                serviceIntent.putExtra(AudioCaptureService.EXTRA_RESULT_DATA, result.getData());
                serviceIntent.putExtra("srcLang", mSrcLang);
                serviceIntent.putExtra("targetLang", mTargetLang);
                serviceIntent.putExtra("voice", mVoice);
                serviceIntent.putExtra("engine", mEngine);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    getContext().startForegroundService(serviceIntent);
                } else {
                    getContext().startService(serviceIntent);
                }

                JSObject ret = new JSObject();
                ret.put("started", true);
                ret.put("message", "Internal digital audio capture running via foreground service");
                call.resolve(ret);
            } else {
                call.reject("MediaProjection permission was cancelled or denied");
            }
        } catch (Throwable t) {
            Log.e(TAG, "Error in mediaProjectionCallback: " + t.getMessage(), t);
            call.reject("Error launching audio service: " + t.getMessage());
        }
    }

    @PluginMethod
    public void stopScreenCapture(PluginCall call) {
        try {
            Intent serviceIntent = new Intent(getContext(), AudioCaptureService.class);
            serviceIntent.setAction(AudioCaptureService.ACTION_STOP);
            getContext().startService(serviceIntent);

            JSObject ret = new JSObject();
            ret.put("stopped", true);
            call.resolve(ret);
        } catch (Throwable t) {
            Log.e(TAG, "Error stopping screen capture: " + t.getMessage(), t);
            call.reject("Error stopping screen capture: " + t.getMessage());
        }
    }
}
