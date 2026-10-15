/** Display-only vendor text; never an identifier, authority claim or scoring input. */
export function tokenDisplayText(value:unknown,maxLength:number):string|undefined {
  if(typeof value!=='string'||value.length>2000)return;
  const text=value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').trim();
  return text?Array.from(text).slice(0,maxLength).join(''):undefined;
}
