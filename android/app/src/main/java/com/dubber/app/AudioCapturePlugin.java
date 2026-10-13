package com.dubber.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AudioCapture")
public class AudioCapturePlugin extends Plugin {

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

        MediaProjectionManager projectionManager = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (projectionManager == null) {
            call.reject("MediaProjectionManager not available");
            return;
        }

        AudioCaptureService.setAudioDataListener(pcmData -> {
            String base64 = Base64.encodeToString(pcmData, Base64.NO_WRAP);
            JSObject data = new JSObject();
            data.put("data", base64);
            data.put("size", pcmData.length);
            notifyListeners("audioChunk", data);
        });

        Intent captureIntent = projectionManager.createScreenCaptureIntent();
        startActivityForResult(call, captureIntent, "mediaProjectionCallback");
    }

    @ActivityCallback
    private void mediaProjectionCallback(PluginCall call, ActivityResult result) {
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
            call.reject("MediaProjection permission denied by user");
        }
    }

    @PluginMethod
    public void stopScreenCapture(PluginCall call) {
        Intent serviceIntent = new Intent(getContext(), AudioCaptureService.class);
        serviceIntent.setAction(AudioCaptureService.ACTION_STOP);
        getContext().startService(serviceIntent);

        JSObject ret = new JSObject();
        ret.put("stopped", true);
        call.resolve(ret);
    }
}
