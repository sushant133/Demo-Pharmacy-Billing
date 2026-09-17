package np.com.mantrasphere.pharmacy;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The WebView has no window.print(); SystemPrint bridges to Android's
        // PrintManager so the "Print bill" button still reaches paper.
        registerPlugin(SystemPrintPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
