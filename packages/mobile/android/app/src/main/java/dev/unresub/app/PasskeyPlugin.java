package dev.unresub.app;

import android.os.CancellationSignal;
import androidx.core.content.ContextCompat;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePublicKeyCredentialRequest;
import androidx.credentials.CreatePublicKeyCredentialResponse;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.exceptions.CreateCredentialCancellationException;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.Executor;

/**
 * Passkeys through Android Credential Manager. The WebView can't run WebAuthn for the server's
 * domain (its origin is https://localhost), so the web app hands the server's WebAuthn options
 * JSON to this plugin and sends the returned JSON back to the server. Android only allows it when
 * the server publishes this app's signing certificate in /.well-known/assetlinks.json.
 */
@CapacitorPlugin(name = "Passkey")
public class PasskeyPlugin extends Plugin {

    private CredentialManager manager() {
        return CredentialManager.create(getContext());
    }

    private Executor executor() {
        return ContextCompat.getMainExecutor(getContext());
    }

    @PluginMethod
    public void create(final PluginCall call) {
        String json = call.getString("requestJson");
        if (json == null) {
            call.reject("requestJson is required");
            return;
        }
        CreatePublicKeyCredentialRequest request = new CreatePublicKeyCredentialRequest(json);
        manager().createCredentialAsync(getActivity(), request, new CancellationSignal(), executor(),
            new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                @Override
                public void onResult(CreateCredentialResponse result) {
                    if (!(result instanceof CreatePublicKeyCredentialResponse)) {
                        call.reject("Unexpected credential type");
                        return;
                    }
                    JSObject ret = new JSObject();
                    ret.put("responseJson", ((CreatePublicKeyCredentialResponse) result).getRegistrationResponseJson());
                    call.resolve(ret);
                }

                @Override
                public void onError(CreateCredentialException e) {
                    if (e instanceof CreateCredentialCancellationException) call.reject("Passkey request cancelled", "NotAllowedError");
                    else call.reject(String.valueOf(e.getMessage()), e.getType());
                }
            });
    }

    @PluginMethod
    public void get(final PluginCall call) {
        String json = call.getString("requestJson");
        if (json == null) {
            call.reject("requestJson is required");
            return;
        }
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(new GetPublicKeyCredentialOption(json))
            .build();
        manager().getCredentialAsync(getActivity(), request, new CancellationSignal(), executor(),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse result) {
                    Credential credential = result.getCredential();
                    if (!(credential instanceof PublicKeyCredential)) {
                        call.reject("Unexpected credential type");
                        return;
                    }
                    JSObject ret = new JSObject();
                    ret.put("responseJson", ((PublicKeyCredential) credential).getAuthenticationResponseJson());
                    call.resolve(ret);
                }

                @Override
                public void onError(GetCredentialException e) {
                    if (e instanceof GetCredentialCancellationException) call.reject("Passkey request cancelled", "NotAllowedError");
                    else if (e instanceof NoCredentialException) call.reject("No passkey for this server on this phone. Use \"Lost your passkey?\" or create an account.", "NoCredential");
                    else call.reject(String.valueOf(e.getMessage()), e.getType());
                }
            });
    }
}
