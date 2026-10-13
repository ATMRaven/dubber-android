package com.dubber.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
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

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q);
        ret.put("apiLevel", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void startScreenCapture(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Android 10 (API 29) or higher is required for internal audio capture");
            return;
        }

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
