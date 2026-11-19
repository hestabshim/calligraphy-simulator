// Character sources for practice sheets.

/** 千字文 Thousand Character Classic, the traditional calligraphy primer (opening passages). */
export const QIANZIWEN =
  '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳' +
  '云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜' +
  '海咸河淡鳞潜羽翔龙师火帝鸟官人皇始制文字乃服衣裳推位让国有虞陶唐' +
  '吊民伐罪周发殷汤坐朝问道垂拱平章爱育黎首臣伏戎羌遐迩一体率宾归王' +
  '鸣凤在竹白驹食场化被草木赖及万方盖此身发四大五常恭惟鞠养岂敢毁伤' +
  '女慕贞洁男效才良知过必改得能莫忘罔谈彼短靡恃己长信使可覆器欲难量' +
  '墨悲丝染诗赞羔羊';

/** 永字八法: 永 contains the eight basic strokes. */
export const YONG = '永';

/** Simple structures for warming up basic strokes. */
export const BASIC_STROKES = '一二三十土王人大天木本未山川口日目田中上下小水火心';

export const NUMBERS = '一二三四五六七八九十百千万';

/** Frequently used characters, mixed into the random pool. */
const COMMON =
  '的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对' +
  '可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公' +
  '同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工己话儿者向情部正' +
  '名定女问力机给等几很业最间新什打便位因重被走电四第门相次东海口使教西再平真听世气信北少关并内' +
  '加化由却代先山五太水万市眼体别处总才场师书比住九笑性通目华报立马命张活难神数安表原车白应路期' +
  '风花雪春秋云雨江河湖林竹石松鹤静和清永德福寿';

export function uniqueHan(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ch of text.match(/\p{Script=Han}/gu) ?? []) {
    if (!seen.has(ch)) {
      seen.add(ch);
      out.push(ch);
    }
  }
  return out;
}

/** Han characters in order, duplicates kept (a set may repeat a character on purpose). */
export function hanSequence(text: string): string[] {
  return text.match(/\p{Script=Han}/gu) ?? [];
}

export const RANDOM_POOL = uniqueHan(QIANZIWEN + COMMON);

export const PRESETS: { id: string; label: string; text: string }[] = [
  { id: 'qianziwen', label: '千字文 Thousand Character Classic', text: QIANZIWEN },
  { id: 'yong', label: '永 Eight principles of 永', text: YONG },
  { id: 'basic', label: '基本 Basic strokes', text: BASIC_STROKES },
  { id: 'numbers', label: '数字 Numbers', text: NUMBERS },
];
