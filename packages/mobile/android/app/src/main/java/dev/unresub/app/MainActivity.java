package dev.unresub.app;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PasskeyPlugin.class);
        registerPlugin(SaveFilePlugin.class);
        super.onCreate(savedInstanceState);

        // Back walks the web app's history (open panel, then previous screen); at the first screen it leaves the app.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web != null && web.canGoBack()) web.goBack();
                else moveTaskToBack(true);
            }
        });
    }
}
