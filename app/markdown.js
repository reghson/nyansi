/* Tiny, safe markdown renderer: escapes all HTML first, then adds formatting. */
(function(){
  const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  function inline(s){
    return s
      .replace(/`([^`]+)`/g,"<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g,"$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  window.renderMarkdown = function(src){
    const blocks=[]; 
    src = src.replace(/```(\w*)\n?([\s\S]*?)```/g,(m,lang,code)=>{blocks.push({lang,code});return "\u0000"+(blocks.length-1)+"\u0000";});
    const lines = esc(src).split("\n"); let out=[], list=null, para=[];
    const flushP=()=>{if(para.length){out.push("<p>"+inline(para.join("<br>"))+"</p>");para=[];}};
    const flushL=()=>{if(list){out.push(`<${list.t}>`+list.items.map(i=>"<li>"+inline(i)+"</li>").join("")+`</${list.t}>`);list=null;}};
    for(const raw of lines){
      const l=raw.trimEnd(); let m;
      if(/^\u0000\d+\u0000$/.test(l.trim())){flushP();flushL();out.push(l.trim());continue;}
      if(!l.trim()){flushP();flushL();continue;}
      if((m=l.match(/^(#{1,4})\s+(.*)/))){flushP();flushL();const n=Math.min(m[1].length+2,6);out.push(`<h${n}>${inline(m[2])}</h${n}>`);continue;}
      if(/^(-{3,}|\*{3,})$/.test(l.trim())){flushP();flushL();out.push("<hr>");continue;}
      if((m=l.match(/^\s*[-*•]\s+(.*)/))){flushP();if(!list||list.t!=="ul"){flushL();list={t:"ul",items:[]};}list.items.push(m[1]);continue;}
      if((m=l.match(/^\s*\d+[.)]\s+(.*)/))){flushP();if(!list||list.t!=="ol"){flushL();list={t:"ol",items:[]};}list.items.push(m[1]);continue;}
      if((m=l.match(/^&gt;\s?(.*)/))){flushP();flushL();out.push("<blockquote>"+inline(m[1])+"</blockquote>");continue;}
      flushL();para.push(l);
    }
    flushP();flushL();
    return out.join("").replace(/\u0000(\d+)\u0000/g,(m,i)=>{const b=blocks[+i];
      return `<div class="code"><div class="code-h"><span>${esc(b.lang||"code")}</span><button class="copy">Copy</button></div><pre><code>${esc(b.code.replace(/\n$/,""))}</code></pre></div>`;});
  };
})();
