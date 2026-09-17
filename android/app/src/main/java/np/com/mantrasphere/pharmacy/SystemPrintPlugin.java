package np.com.mantrasphere.pharmacy;

import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Raises Android's print sheet for the page currently in the WebView.
 *
 * The WebView has no `window.print()` - calling it from JS does nothing at
 * all, silently. On a pharmacy till that reads as a printer that has stopped
 * working, so the web layer calls this instead (see print-transport.ts) and
 * the receipt's own 80mm print CSS is what gets rendered.
 */
@CapacitorPlugin(name = "SystemPrint")
public class SystemPrintPlugin extends Plugin {

    @PluginMethod
    public void print(PluginCall call) {
        final String jobName = call.getString("name", "Bill");

        // PrintManager and createPrintDocumentAdapter both insist on the main
        // thread; the bridge calls plugins off it.
        getActivity()
            .runOnUiThread(
                () -> {
                    try {
                        WebView webView = getBridge().getWebView();
                        PrintManager printManager = (PrintManager) getActivity()
                            .getSystemService(android.content.Context.PRINT_SERVICE);

                        if (printManager == null) {
                            call.reject("This device has no print service.");
                            return;
                        }

                        PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(jobName);

                        printManager.print(
                            jobName,
                            adapter,
                            new PrintAttributes.Builder()
                                .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                .build()
                        );

                        call.resolve(new JSObject().put("started", true));
                    } catch (Exception error) {
                        call.reject("Could not open the print sheet.", error);
                    }
                }
            );
    }
}
