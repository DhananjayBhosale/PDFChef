import assert from 'node:assert/strict';
import test from 'node:test';
import { getPdfPreviewFont, unsupportedPdfPreviewCharacter } from '../../services/pdfPreviewFont.ts';

test('preview coverage rejects unsupported text before measurement, including emoji code points', async () => {
  for (const bold of [false, true]) {
    const font = await getPdfPreviewFont(bold);
    for (const text of ['गोपनीय', '保密', '📄 {n}']) {
      const character = unsupportedPdfPreviewCharacter(font, text);
      assert.equal(character, [...text][0]);
      assert.throws(() => font.widthOfTextAtSize(text, 12));
    }
    assert.equal(unsupportedPdfPreviewCharacter(font, 'Résumé — Page 1 / 2'), null);
    assert.ok(font.widthOfTextAtSize('Résumé — Page 1 / 2', 12) > 0);
    assert.equal(unsupportedPdfPreviewCharacter(font, ''), null);
  }
});
