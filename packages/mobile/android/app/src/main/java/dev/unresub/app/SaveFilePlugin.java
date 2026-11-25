package dev.unresub.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Saves text the web app made (data export, recovery codes) through the system "Save as" picker.
 * The WebView ignores blob downloads, so <a download> does nothing in the app.
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String name = call.getString("name", "unresub.txt");
        String mime = call.getString("mime", "text/plain");
        if (call.getString("text") == null) {
            call.reject("No content");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime)
            .putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "onPicked");
    }

    @ActivityCallback
    private void onPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = result.getData() != null ? result.getData().getData() : null;
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            JSObject ret = new JSObject();
            ret.put("saved", false);
            call.resolve(ret);
            return;
        }
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new java.io.IOException("Can't open the file");
            out.write(call.getString("text").getBytes(StandardCharsets.UTF_8));
            JSObject ret = new JSObject();
            ret.put("saved", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Couldn't save the file: " + e.getMessage());
        }
    }
}
