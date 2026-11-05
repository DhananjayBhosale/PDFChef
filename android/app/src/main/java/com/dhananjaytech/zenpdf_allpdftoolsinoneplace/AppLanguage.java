package com.dhananjaytech.zenpdf_allpdftoolsinoneplace;

import android.content.Context;
import android.content.res.Configuration;
import android.os.LocaleList;
import androidx.annotation.Nullable;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The app's language for native screens. The web layer sends the language chosen in its Settings,
 * or {@link #SYSTEM} while Settings is on System, in which case native screens follow the phone the
 * way Android resources already do. The choice is kept so a reader opened before the web layer
 * starts still uses it, and a later phone language change needs no message.
 */
public final class AppLanguage {
    private static final String PREFERENCES = "pdfchef_language";
    private static final String KEY = "tag";
    private static final Pattern TAG = Pattern.compile("[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}");

    static final String SYSTEM = "system";

    private AppLanguage() {}

    static boolean isValid(@Nullable String tag) {
        return SYSTEM.equals(tag) || (tag != null && tag.length() <= 35 && TAG.matcher(tag).matches());
    }

    static void save(Context context, String tag) {
        android.content.SharedPreferences.Editor editor = context.getApplicationContext()
                .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit();
        if (SYSTEM.equals(tag)) editor.remove(KEY);
        else editor.putString(KEY, tag);
        editor.apply();
    }

    @Nullable
    private static String saved(Context context) {
        String tag = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(KEY, null);
        return isValid(tag) && !SYSTEM.equals(tag) ? tag : null;
    }

    /** {@code base} with the language chosen in the app, or {@code base} itself while it follows the phone. */
    public static Context wrap(Context base) {
        String tag = saved(base);
        if (tag == null) return base;
        Configuration configuration = new Configuration(base.getResources().getConfiguration());
        configuration.setLocales(new LocaleList(Locale.forLanguageTag(tag)));
        return base.createConfigurationContext(configuration);
    }
}
