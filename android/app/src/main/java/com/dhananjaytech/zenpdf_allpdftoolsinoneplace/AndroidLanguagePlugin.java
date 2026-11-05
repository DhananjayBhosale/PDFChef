package com.dhananjaytech.zenpdf_allpdftoolsinoneplace;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Receives the language the web layer shows, so native screens use the same one. */
@CapacitorPlugin(name = "AndroidLanguage")
public final class AndroidLanguagePlugin extends Plugin {
    @PluginMethod
    public void setLanguage(PluginCall call) {
        JSObject data = call.getData();
        String tag = data == null || data.length() != 1 ? null : data.getString("language");
        if (!AppLanguage.isValid(tag)) {
            call.reject("The language is invalid.", "LANGUAGE_INVALID_ARGUMENT");
            return;
        }
        AppLanguage.save(getContext(), tag);
        call.resolve();
    }
}
