# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ML Kit discovers this registrar by name; retain only its public constructor.
-keepclassmembers class com.google.mlkit.common.internal.CommonComponentRegistrar {
    public <init>();
}

# PdfBox can optionally decode and encode JPEG 2000 images through this commercial
# library. Signature verification never renders page images, and verified copies
# keep existing image streams as they are, so neither path is ever called.
-dontwarn com.gemalto.jp2.JP2Decoder
-dontwarn com.gemalto.jp2.JP2Encoder

# Bouncy Castle resolves digest, signature, and certificate implementations by name.
# Signature verification only needs these; the LDAP-backed org.bouncycastle.jce.provider
# stores are never used and reference javax.naming, which Android does not ship.
-keep,allowoptimization class org.bouncycastle.jcajce.provider.** { *; }
