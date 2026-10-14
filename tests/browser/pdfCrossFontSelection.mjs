/** Regression: repeated text cannot identify a browser selection; actual target range must preserve the untouched font. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { chromium } from 'playwright';
const baseUrl = process.env.PDF_CHEF_URL || 'http://127.0.0.1:4173';
const outputRoot = process.env.PDF_CHEF_CROSS_FONT_OUTPUT || 'output/pdf-cross-font-selection';
const doc=await PDFDocument.create();const regular=await doc.embedFont(StandardFonts.Helvetica);const bold=await doc.embedFont(StandardFonts.HelveticaBold);const p=doc.addPage([612,792]);
p.drawText('abc',{x:72,y:700,font:regular,size:12});p.drawText('abc',{x:72+regular.widthOfTextAtSize('abc',12),y:700,font:bold,size:12});
const bytes=Buffer.from(await doc.save());
const browser=await chromium.launch({headless:true});
try {
 for (const newline of [false, true]) {
 const dir = `${outputRoot}/${newline ? 'second-line' : 'single-line'}`;
 await mkdir(dir, {recursive:true});
 await writeFile(`${dir}/crossfont-ambiguous-original.pdf`,bytes);
 const context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage();
 await page.addInitScript(()=>localStorage.setItem('pdfchef.workspace.settings.v1',JSON.stringify({autoDownload:false,keepLocalHistory:false,onboardingComplete:true,confirmLargeJobs:false})));
 const errors=[],warnings=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='warning')warnings.push(m.text());});
 let receive;const output=new Promise(resolve=>receive=resolve);await page.exposeFunction('__captureReviewOutput',receive);
 await page.addInitScript(()=>window.addEventListener('pdfchef:output-ready',async e=>window.__captureReviewOutput([...new Uint8Array(await e.detail.blob.arrayBuffer())])));
 await page.goto(`${baseUrl}/edit`);await page.locator('input[type=file][accept=".pdf"]').setInputFiles({name:'crossfont.pdf',mimeType:'application/pdf',buffer:bytes});
 const initial=page.getByTestId('pdf-text-block').filter({hasText:'abcabc'});await initial.waitFor({timeout:45000});const id=await initial.getAttribute('data-block-id');const para=page.locator(`[data-testid="pdf-text-block"][data-block-id="${id}"]`);
 const beforeSpans=await para.locator('span[data-font]').evaluateAll(a=>a.map(e=>({text:e.textContent,font:e.dataset.font,size:e.dataset.fontSize})));
 const select = async (start,end) => para.evaluate((el,{start,end})=>{el.focus();const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;let offset=0;const r=document.createRange();let started=false;while(n=w.nextNode()){const next=offset+n.textContent.length;if(!started && next>=start){r.setStart(n,start-offset);started=true;}if(started && next>=end){r.setEnd(n,end-offset);break;}offset=next;}const selection=getSelection();selection.removeAllRanges();selection.addRange(r);},{start,end});
 const expectText = async text => page.waitForFunction(({id,text})=>document.querySelector(`[data-block-id="${id}"]`)?.textContent===text,{id,text});
 if (newline) {
  await select(0,0);await page.keyboard.insertText('Header');await page.keyboard.press('Shift+Enter');
  assert.equal(await para.innerText(), 'Header\nabcabc');
  // Chromium's plaintext-only surface keeps the intentional break in its text node.
 }
 await select(newline ? 7 : 0,newline ? 11 : 4);await page.keyboard.insertText('a');
 assert.equal(await para.innerText(), newline ? 'Header\nabc' : 'abc');
 await page.waitForFunction(()=>/will be redrawn/.test(document.querySelector('[data-testid="pdf-paragraph-provenance"]')?.textContent??''));
 const provenance=await page.getByTestId('pdf-paragraph-provenance').innerText();
 const spansAfter=await para.locator('span').evaluateAll(spans=>spans.map(e=>({text:e.textContent,font:e.dataset.font,weight:e.style.fontWeight})));
 await page.getByRole('button',{name:'Done',exact:true}).click();
 await page.screenshot({path:`${dir}/crossfont-ambiguous-before-save.png`,fullPage:true});
 await page.getByRole('button',{name:/^Save/}).first().click();
 let timer;const result=await Promise.race([output,new Promise((_,rej)=>timer=setTimeout(()=>rej(new Error('No export')),45000))]).finally(()=>clearTimeout(timer));
 await writeFile(`${dir}/crossfont-ambiguous-export.pdf`,Uint8Array.from(result));
 const load=pdfjs.getDocument({data:Uint8Array.from(result),fontExtraProperties:true,standardFontDataUrl:`${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`});const pdf=await load.promise;const loadedPage=await pdf.getPage(1);await loadedPage.getOperatorList();
 const after=(await loadedPage.getTextContent()).items.filter(i=>i.str?.trim()).map(i=>({text:i.str,font:loadedPage.commonObjs.get(i.fontName).name,transform:i.transform}));await load.destroy();
 assert.deepEqual(after.map(({text,font,transform})=>({text,font,size:Math.hypot(transform[0],transform[1])})), [
  ...(newline ? [{text:'Header',font:'Helvetica',size:12}] : []),
  {text:'a',font:'Helvetica',size:12}, {text:'bc',font:'Helvetica-Bold',size:12},
 ], 'The actual selected occurrence must determine the untouched suffix font');
 assert.deepEqual(errors, []); assert.deepEqual(warnings, []); 
 const report={beforeSpans,provenance,after,errors,warnings,uiAfter:await page.locator('body').innerText()};await writeFile(`${dir}/crossfont-ambiguous-result.json`,JSON.stringify(report,null,2));console.log(`PASS ${newline ? 'second-line' : 'single-line'} repeated cross-font selection: replacement keeps Helvetica 12, untouched suffix keeps Helvetica-Bold 12`);await context.close();
 }
}finally{await browser.close();}
