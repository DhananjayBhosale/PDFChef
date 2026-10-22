// Plain ES5 on purpose: this runs on WebViews too old for the app itself.
(function () {
  'use strict';
  // [heading, the one sentence that says what to do, button]
  var TEXT = {
    en: ['Update Android System WebView', 'PDF Chef needs a newer version of Android System WebView. Update it on Google Play, then open PDF Chef again.', 'Open Google Play'],
    ar: ['حدِّث Android System WebView', 'يحتاج PDF Chef إلى إصدار أحدث من Android System WebView. حدِّثه من Google Play، ثم افتح PDF Chef مرة أخرى.', 'فتح Google Play'],
    da: ['Opdater Android System WebView', 'PDF Chef skal bruge en nyere version af Android System WebView. Opdater den i Google Play, og åbn derefter PDF Chef igen.', 'Åbn Google Play'],
    de: ['Android System WebView aktualisieren', 'PDF Chef braucht eine neuere Version von Android System WebView. Aktualisiere sie bei Google Play und öffne PDF Chef dann erneut.', 'Google Play öffnen'],
    es: ['Actualiza Android System WebView', 'PDF Chef necesita una versión más reciente de Android System WebView. Actualízala en Google Play y vuelve a abrir PDF Chef.', 'Abrir Google Play'],
    fr: ['Mettre à jour Android System WebView', 'PDF Chef a besoin d’une version plus récente d’Android System WebView. Mettez-la à jour sur Google Play, puis rouvrez PDF Chef.', 'Ouvrir Google Play'],
    hi: ['Android System WebView अपडेट करें', 'PDF Chef को Android System WebView के नए वर्शन की ज़रूरत है। इसे Google Play से अपडेट करें, फिर PDF Chef दोबारा खोलें।', 'Google Play खोलें'],
    id: ['Perbarui Android System WebView', 'PDF Chef memerlukan versi Android System WebView yang lebih baru. Perbarui di Google Play, lalu buka PDF Chef lagi.', 'Buka Google Play'],
    it: ['Aggiorna Android System WebView', 'PDF Chef richiede una versione più recente di Android System WebView. Aggiornala su Google Play, poi riapri PDF Chef.', 'Apri Google Play'],
    ja: ['Android System WebView を更新してください', 'PDF Chef には新しいバージョンの Android System WebView が必要です。Google Play で更新してから、PDF Chef をもう一度開いてください。', 'Google Play を開く'],
    ko: ['Android System WebView 업데이트', 'PDF Chef를 사용하려면 최신 버전의 Android System WebView가 필요합니다. Google Play에서 업데이트한 후 PDF Chef를 다시 여세요.', 'Google Play 열기'],
    nl: ['Werk Android System WebView bij', 'PDF Chef heeft een nieuwere versie van Android System WebView nodig. Werk deze bij via Google Play en open PDF Chef daarna opnieuw.', 'Google Play openen'],
    pl: ['Zaktualizuj Android System WebView', 'PDF Chef wymaga nowszej wersji Android System WebView. Zaktualizuj ją w Google Play, a potem ponownie otwórz PDF Chef.', 'Otwórz Google Play'],
    'pt-BR': ['Atualize o Android System WebView', 'O PDF Chef precisa de uma versão mais recente do Android System WebView. Atualize-o no Google Play e abra o PDF Chef de novo.', 'Abrir o Google Play'],
    'pt-PT': ['Atualize o Android System WebView', 'O PDF Chef precisa de uma versão mais recente do Android System WebView. Atualize-o no Google Play e volte a abrir o PDF Chef.', 'Abrir o Google Play'],
    sv: ['Uppdatera Android System WebView', 'PDF Chef behöver en nyare version av Android System WebView. Uppdatera den på Google Play och öppna sedan PDF Chef igen.', 'Öppna Google Play'],
    tr: ['Android System WebView’i güncelleyin', 'PDF Chef, Android System WebView’in daha yeni bir sürümüne ihtiyaç duyuyor. Google Play’den güncelleyin, ardından PDF Chef’i yeniden açın.', 'Google Play’i açın'],
    'zh-Hans': ['更新 Android System WebView', 'PDF Chef 需要较新版本的 Android System WebView。请在 Google Play 中更新，然后重新打开 PDF Chef。', '打开 Google Play'],
    'zh-Hant': ['更新 Android System WebView', 'PDF Chef 需要較新版本的 Android System WebView。請在 Google Play 更新，然後重新開啟 PDF Chef。', '開啟 Google Play']
  };

  var pick = function (tag) {
    var value = String(tag || '').toLowerCase().replace(/_/g, '-');
    var language = value.split('-')[0];
    if (language === 'zh') return /(^|-)(hant|tw|hk|mo)(-|$)/.test(value) ? 'zh-Hant' : 'zh-Hans';
    if (language === 'pt') return /^pt-pt(-|$)/.test(value) ? 'pt-PT' : 'pt-BR';
    if (language === 'in') return 'id';
    return Object.prototype.hasOwnProperty.call(TEXT, language) ? language : null;
  };

  // The language chosen in the app's Settings comes first, then the phone's languages.
  var tags = [];
  try {
    var saved = window.localStorage.getItem('pdfchef.locale.v1');
    if (saved && saved !== 'system') tags.push(saved);
  } catch (ignored) {
    // Storage can be unavailable; the phone's languages still apply.
  }
  var languages = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  for (var i = 0; i < languages.length; i++) tags.push(languages[i]);

  var key = 'en';
  for (var j = 0; j < tags.length; j++) {
    var found = pick(tags[j]);
    if (found) { key = found; break; }
  }
  var text = TEXT[key];
  document.documentElement.lang = key;
  document.documentElement.dir = key === 'ar' ? 'rtl' : 'ltr';
  document.title = text[0];
  document.getElementById('title').textContent = text[0];
  document.getElementById('message').textContent = text[1];
  document.getElementById('play').textContent = text[2];
}());
