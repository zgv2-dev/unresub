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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Saves text the web app made (data export, recovery codes) through the system "Save as" picker.
 * The WebView ignores blob downloads, so <a download> does nothing in the app.
 *
 * The text goes to a cache file before the picker opens and is copied once a place is chosen, so
 * nothing depends on the call's data surviving the trip through another activity.
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    private File pending() {
        return new File(getContext().getCacheDir(), "save-file.pending");
    }

    @PluginMethod
    public void save(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.isEmpty()) {
            call.reject("Nothing to save");
            return;
        }
        try (OutputStream out = new FileOutputStream(pending())) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            call.reject("Couldn't prepare the file: " + e.getMessage());
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(call.getString("mime", "text/plain"))
            .putExtra(Intent.EXTRA_TITLE, call.getString("name", "unresub.txt"));
        startActivityForResult(call, intent, "onPicked");
    }

    @ActivityCallback
    private void onPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        File src = pending();
        Uri uri = result.getData() != null ? result.getData().getData() : null;
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            src.delete();
            JSObject ret = new JSObject();
            ret.put("saved", false);
            call.resolve(ret);
            return;
        }
        long written = 0;
        // "w", not "wt": some document providers reject truncate mode, and a new document is empty anyway.
        try (InputStream in = new FileInputStream(src); OutputStream out = getContext().getContentResolver().openOutputStream(uri, "w")) {
            if (out == null) throw new java.io.IOException("Can't open the file");
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) {
                out.write(buf, 0, n);
                written += n;
            }
            out.flush();
        } catch (Exception e) {
            call.reject("Couldn't save the file: " + e.getMessage());
            return;
        } finally {
            src.delete();
        }
        JSObject ret = new JSObject();
        ret.put("saved", true);
        ret.put("bytes", written);
        call.resolve(ret);
    }
}
