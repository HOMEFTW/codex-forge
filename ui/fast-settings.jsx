import React, {useEffect,useState} from 'react';

export default function FastModelSettings({plugin,call}) {
  const [value,setValue]=useState(null),[models,setModels]=useState(null),[error,setError]=useState(''),[listError,setListError]=useState(''),[notice,setNotice]=useState(''),[saving,setSaving]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{let live=true;call('settings',{id:plugin.id}).then(result=>live&&setValue(result)).catch(e=>live&&setError(e.message));return()=>{live=false;};},[plugin.id]);
  useEffect(()=>{
    if(!value)return;
    let live=true;setModels(null);setListError('');
    call('fastModels',{enableTerra:value.enableTerra}).then(result=>live&&setModels(result)).catch(e=>live&&setListError(e.message));
    return()=>{live=false;};
  },[value?.enableTerra,revision]);
  const hidden=value?.hiddenModels||[],visible=models?.filter(model=>!hidden.includes(model.id)).length||0;
  const empty=!!models?.length&&visible===0;
  function change(next){setValue(current=>({...current,...next}));setNotice('');setError('');}
  async function save(){
    setSaving(true);setError('');setNotice('');
    try{const saved=await call('saveSettings',{id:plugin.id,value});setValue(saved);setNotice('已保存，完整退出并重新启动客户端后生效。');}
    catch(e){setError(e.message);}finally{setSaving(false);}
  }
  return <div className="forge-settings-form forge-fast-settings">
    {!plugin.enabled&&<p className="forge-muted">插件已停用；启用并重启后将应用这些设置。</p>}
    {error&&<p className="forge-error" role="alert">{error}</p>}
    {!value?<p>正在读取设置…</p>:<>
      <label>默认速度<select value={value.defaultSpeed} disabled={saving} onChange={e=>change({defaultSpeed:e.target.value})}><option value="fast">Fast（默认）</option><option value="ultrafast">Ultrafast</option><option value="native">跟随客户端选择</option></select></label>
      <label className="forge-fast-toggle"><input type="checkbox" checked={value.enableTerra} disabled={saving} onChange={e=>change({enableTerra:e.target.checked})}/><span>启用 GPT-6.1-Terra 模型与 Fast 支持</span></label>
      <p className="forge-muted">补齐 Terra 模型和 Fast 档位。Fast 的实际可用性与计费由模型服务决定。</p>
      <label>额外启用 Ultrafast 的模型（每行一个模型 ID）<textarea value={(value.ultrafastModels||[]).join('\n')} disabled={saving} onChange={e=>change({ultrafastModels:e.target.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)})}/></label>
      <p className="forge-muted">模型目录自带的 Ultrafast 会自动显示。若自定义服务支持该档位，可在此补充模型 ID；发送独立的 ultrafast 参数，服务不支持时可能拒绝请求。</p>
      <div className="forge-model-heading"><h3>对话中可选择的模型</h3><span>{models?`${visible} / ${models.length} 个显示`:''}</span></div>
      <p className="forge-muted">取消勾选后，模型将从切换菜单隐藏；已有对话的模型保持不变。原生默认隐藏的模型不在此列表中。</p>
      <div className="forge-actions"><button type="button" disabled={saving||!hidden.length} onClick={()=>change({hiddenModels:[]})}>恢复默认显示</button><button type="button" disabled={saving} onClick={()=>setRevision(revision+1)}>重新读取模型</button></div>
      {listError&&<p className="forge-error" role="alert">{listError}</p>}
      {!models&&!listError&&<p role="status">正在读取模型…</p>}
      {models?.length===0&&<p>尚无可选择的模型。请先让客户端获取模型目录，再重新读取。</p>}
      {empty&&<p className="forge-error" role="alert">请至少保留一个可选择的模型。</p>}
      {models&&<div className="forge-model-list">{models.map(model=>{
        const checked=!hidden.includes(model.id);
        return <label className="forge-model-item" key={model.id}><input type="checkbox" aria-label={'显示 '+model.id} checked={checked} disabled={saving||checked&&visible===1} onChange={e=>change({hiddenModels:e.target.checked?hidden.filter(id=>id!==model.id):[...hidden,model.id]})}/><span><strong>{model.name}</strong><code>{model.id}</code></span>{model.fast&&<small>Fast</small>}</label>;
      })}</div>}
      <button disabled={saving||empty||!models&&!listError} onClick={save}>{saving?'正在保存…':'保存设置'}</button>
      {notice&&<p role="status">{notice}</p>}
    </>}
  </div>;
}
