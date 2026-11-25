package dev.unresub.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Saves text the web app made (data export, recovery codes) straight into Downloads.
 * The WebView ignores blob downloads, and the system "Save as" picker didn't hand control back to
 * the app on some phones (singleTask activity), leaving an empty file. MediaStore needs no picker
 * and no permission on Android 10+.
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.isEmpty()) {
            call.reject("Nothing to save");
            return;
        }
        String name = call.getString("name", "unresub.txt");
        String mime = call.getString("mime", "text/plain");
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        try {
            String where = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? toDownloads(name, mime, bytes) : toAppFolder(name, bytes);
            JSObject ret = new JSObject();
            ret.put("saved", true);
            ret.put("bytes", bytes.length);
            ret.put("location", where);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Couldn't save the file: " + e.getMessage());
        }
    }

    private String toDownloads(String name, String mime, byte[] bytes) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, mime);
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new java.io.IOException("Downloads is not available");
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new java.io.IOException("Can't open the file");
            out.write(bytes);
        } catch (Exception e) {
            resolver.delete(uri, null, null);
            throw e;
        }
        values.clear();
        values.put(MediaStore.Downloads.IS_PENDING, 0);
        resolver.update(uri, values, null, null);
        return "Downloads";
    }

    /** Android 7–9: public Downloads needs a storage permission, so use the app's own Downloads folder. */
    private String toAppFolder(String name, byte[] bytes) throws Exception {
        File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) throw new java.io.IOException("Storage is not available");
        dir.mkdirs();
        File file = new File(dir, name);
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
        }
        return file.getAbsolutePath();
    }
}
