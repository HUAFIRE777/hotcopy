const ADDONS_API_BASE = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  ? 'http://127.0.0.1:3002'
  : API_BASE;
const ASSET_PLATFORM_LABELS = {
  douyin: '抖音', xiaohongshu: '小红书', shipinhao: '视频号',
  tiktok: 'TikTok', youtube: 'YouTube'
};

let activeAsset = null;
let activeAssetRequest = null;
let activeAssetSourceUrl = '';
let activeProjectId = null;
let activeProjectSourceUrl = '';
let activeProjectTitle = '';
let radarCreateBusy = false;
let activeKitTab = 0;
const assetDrafts = new Map();

function draftKey(sourceUrl, type, platform = '') {
  return JSON.stringify([sourceUrl, type, platform]);
}

function rememberAsset(asset, sourceUrl = activeModalUrl) {
  activeAssetSourceUrl = sourceUrl;
  asset.sourceUrl = sourceUrl;
  assetDrafts.set(draftKey(sourceUrl, asset.type, asset.platform || ''), asset);
}

function onAddonSourceChange(sourceUrl) {
  document.getElementById('projectSaveRow').classList.add('hidden');
  document.getElementById('productionKitButton').classList.remove('ring-2', 'ring-orange-400');
  document.getElementById('kitProjectSaveButton').textContent = '保存为创作项目';
  document.getElementById('projectSaveButton').textContent = activeProjectSourceUrl === sourceUrl
    ? '已保存项目' : '保存项目';
}

function cancelAssetGeneration() {
  activeAssetRequest?.abort();
}

function setAssetBusy(busy, type = '') {
  document.querySelectorAll('.asset-generate-btn').forEach(button => {
    button.disabled = busy;
    button.classList.toggle('opacity-50', busy);
  });
  document.getElementById('assetSourceNotice').textContent = busy
    ? type === 'production-kit'
      ? '正在定制全套制作包（分镜 / 封面 / 图文 / 导图）…'
      : '正在整理成稿，请保持页面开启…'
    : '使用已打开的原声全文生成，不重复听译。';
}

function openAssetPanel(title) {
  document.getElementById('resultText').classList.add('hidden');
  document.getElementById('resultActions').classList.add('hidden');
  document.getElementById('assetResultPanel').classList.remove('hidden');
  document.getElementById('assetResultTitle').textContent = title;
  document.getElementById('kitProjectSaveButton').classList.add('hidden');
}

function closeAssetResult() {
  document.getElementById('assetResultPanel').classList.add('hidden');
  document.getElementById('resultText').classList.remove('hidden');
  document.getElementById('resultActions').classList.remove('hidden');
}

function appendAssetText(parent, tagName, value, className = '') {
  const element = document.createElement(tagName);
  element.textContent = value;
  if (className) element.className = className;
  parent.appendChild(element);
  return element;
}

function assetMarkdown(asset) {
  if (asset.type === 'production-kit') {
    const data = asset.data;
    return `# ${asset.title}\n\n## 分镜口播\n\n${kitScriptText(data)}\n\n## 封面建议\n\n${data.cover_options.map((option, index) => `${index + 1}. ${option.main}\n   ${option.sub}`).join('\n\n')}\n\n## 社媒图文\n\n### ${data.social_post.title}\n\n${data.social_post.body}\n\n${data.social_post.tags.join(' ')}\n\n## 知识脑图（Mermaid）\n\n\`\`\`mermaid\n${data.mindmap_mermaid}\n\`\`\``;
  }
  if (asset.type === 'production-package') {
    const data = asset.data;
    return `# ${asset.title}\n\n平台：${ASSET_PLATFORM_LABELS[asset.platform]} · ${data.format}\n\n## 口播稿\n\n${data.script_markdown}\n\n## 分段画面\n\n${data.sections.map((section, index) => `### ${index + 1}. ${section.label}\n\n口播：${section.narration}\n\n画面：${section.visual_guidance}`).join('\n\n')}\n\n## 给 Agent 的制作指令\n\n${data.agent_prompt}`;
  }
  if (asset.type === 'xiaohongshu') {
    const data = asset.data;
    return `# ${data.title}\n\n${data.hook}\n\n${data.sections.map(section => `## ${section.subtitle}\n\n${section.body}`).join('\n\n')}\n\n${data.tags.join(' ')}`;
  }
  if (asset.type === 'short-video') return asset.data.script_markdown;
  const tree = asset.data.json_tree;
  return `# ${tree.title}\n\n${tree.branches.map(branch => `- ${branch.title}\n${branch.children.map(child => `  - ${child}`).join('\n')}`).join('\n')}`;
}

function kitScriptText(data) {
  return data.teleprompter_script.map(step => `### ${step.stage}\n\n口播：${step.spoken}\n\n画面：${step.visual_cue}`).join('\n\n');
}

async function copyKitText(kind, index = 0) {
  if (activeAsset?.type !== 'production-kit') return;
  const data = activeAsset.data;
  const value = kind === 'spoken' ? data.teleprompter_script.map(step => step.spoken).join('\n\n')
    : kind === 'script' ? kitScriptText(data)
    : kind === 'cover' ? `${data.cover_options[index].main}\n${data.cover_options[index].sub}`
    : kind === 'social' ? `${data.social_post.title}\n\n${data.social_post.body}\n\n${data.social_post.tags.join(' ')}`
    : data.mindmap_mermaid;
  try { await navigator.clipboard.writeText(value); showToast('已复制，可直接继续编辑'); }
  catch { showToast('复制失败，请手动选择文本'); }
}

function kitAction(parent, label, kind, index = 0) {
  const button = appendAssetText(parent, 'button', label,
    'min-h-11 rounded-lg border border-stone-200 bg-white px-3 text-xs font-medium text-stone-800');
  button.type = 'button';
  button.addEventListener('click', () => copyKitText(kind, index));
  return button;
}

function renderKitMindmapSvg(parent, tree) {
  const wrapper = document.createElement('div');
  wrapper.className = 'mb-3 overflow-x-auto rounded-xl border border-stone-200 bg-white p-3';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const leafCount = tree.branches.reduce((total, branch) => total + branch.children.length, 0);
  const height = Math.max(260, leafCount * 48 + 32);
  svg.setAttribute('viewBox', `0 0 800 ${height}`);
  svg.setAttribute('width', '800');
  svg.setAttribute('height', String(height));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${tree.title} 知识脑图`);
  function shape(tag, attributes, value) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attributes).forEach(([key, entry]) => element.setAttribute(key, String(entry)));
    if (value !== undefined) element.textContent = value;
    svg.appendChild(element);
  }
  function node(x, y, width, label, fill, ink) {
    shape('rect', { x, y: y - 18, width, height: 36, rx: 10, fill });
    shape('text', { x: x + 12, y: y + 5, fill: ink, 'font-size': 14,
      'font-family': 'system-ui, sans-serif' }, label);
  }
  const center = height / 2;
  node(20, center, 158, tree.title, '#292524', '#ffffff');
  let leafIndex = 0;
  tree.branches.forEach(branch => {
    const branchStart = leafIndex;
    const branchCenter = 40 + (branchStart + (branch.children.length - 1) / 2) * 48;
    shape('path', { d: `M178 ${center} C220 ${center}, 225 ${branchCenter}, 265 ${branchCenter}`,
      stroke: '#d6d3d1', 'stroke-width': 2, fill: 'none' });
    node(265, branchCenter, 190, branch.title, '#ffedd5', '#7c2d12');
    branch.children.forEach(child => {
      const leafCenter = 40 + leafIndex * 48;
      shape('path', { d: `M455 ${branchCenter} C485 ${branchCenter}, 495 ${leafCenter}, 525 ${leafCenter}`,
        stroke: '#d6d3d1', 'stroke-width': 2, fill: 'none' });
      node(525, leafCenter, 255, child, '#f5f5f4', '#292524');
      leafIndex += 1;
    });
  });
  wrapper.appendChild(svg);
  parent.appendChild(wrapper);
}

function renderProductionKit(body, data) {
  const tabBar = document.createElement('div');
  tabBar.className = 'mb-4 flex gap-2 overflow-x-auto pb-1';
  tabBar.setAttribute('role', 'tablist');
  const content = document.createElement('div');
  body.append(tabBar, content);
  const labels = ['分镜口播', '封面建议', '社媒图文', '知识脑图'];
  const tabs = labels.map((label, index) => {
    const button = appendAssetText(tabBar, 'button', label,
      'min-h-11 shrink-0 rounded-lg border px-3 text-xs font-medium');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => {
      activeKitTab = index;
      showTab(index);
    });
    return button;
  });
  function showTab(index) {
    tabs.forEach((button, buttonIndex) => {
      const selected = buttonIndex === index;
      button.classList.toggle('bg-stone-900', selected);
      button.classList.toggle('text-white', selected);
      button.classList.toggle('border-stone-900', selected);
      button.classList.toggle('bg-white', !selected);
      button.classList.toggle('text-stone-700', !selected);
      button.classList.toggle('border-stone-200', !selected);
      button.setAttribute('aria-selected', String(selected));
    });
    content.replaceChildren();
    if (index === 0) {
      const actions = document.createElement('div');
      actions.className = 'mb-3 flex flex-wrap gap-2';
      kitAction(actions, '复制纯台词', 'spoken');
      kitAction(actions, '复制剪辑脚本', 'script');
      content.appendChild(actions);
      data.teleprompter_script.forEach(step => {
        appendAssetText(content, 'h3', step.stage);
        appendAssetText(content, 'p', step.spoken, 'whitespace-pre-wrap');
        appendAssetText(content, 'p', `画面：${step.visual_cue}`, 'text-stone-500 whitespace-pre-wrap');
      });
    } else if (index === 1) {
      data.cover_options.forEach((option, optionIndex) => {
        const card = document.createElement('div');
        card.className = 'mb-3 rounded-xl border border-stone-200 bg-white p-4';
        appendAssetText(card, 'p', option.main, 'text-lg font-bold text-stone-900');
        appendAssetText(card, 'p', option.sub, 'mt-1 text-sm text-stone-500');
        kitAction(card, `复制第 ${optionIndex + 1} 组`, 'cover', optionIndex);
        content.appendChild(card);
      });
    } else if (index === 2) {
      kitAction(content, '复制图文', 'social');
      appendAssetText(content, 'h3', data.social_post.title);
      appendAssetText(content, 'p', data.social_post.body, 'whitespace-pre-wrap');
      appendAssetText(content, 'p', data.social_post.tags.join(' '), 'text-orange-700');
    } else {
      kitAction(content, '复制 Mermaid 代码', 'mermaid');
      renderKitMindmapSvg(content, data.mindmap_tree);
      appendAssetText(content, 'pre', data.mindmap_mermaid,
        'mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-stone-100 p-3 text-[11px] text-stone-600');
    }
  }
  showTab(activeKitTab);
}

function renderAsset(asset) {
  const body = document.getElementById('assetResultBody');
  body.replaceChildren();
  openAssetPanel(asset.title);
  if (asset.type === 'production-kit') {
    renderProductionKit(body, asset.data);
    if (currentUser?.plan === 'pro') {
      appendAssetText(body, 'p', 'Pro 可复制或下载整套内容；保存全套制作包到项目需 Premium。',
        'mt-3 text-xs text-stone-500');
    }
  } else if (asset.type === 'xiaohongshu') {
    appendAssetText(body, 'h2', asset.data.title);
    appendAssetText(body, 'p', asset.data.hook);
    asset.data.sections.forEach(section => {
      appendAssetText(body, 'h3', section.subtitle);
      appendAssetText(body, 'p', section.body);
    });
    appendAssetText(body, 'p', asset.data.tags.join(' '), 'text-orange-700');
  } else if (asset.type === 'short-video') {
    body.innerHTML = renderMarkdown(asset.data.script_markdown);
  } else if (asset.type === 'production-package') {
    appendAssetText(body, 'p', `${ASSET_PLATFORM_LABELS[asset.platform]} · ${asset.data.format} · 可交给视频 Agent 继续制作`, 'text-xs text-stone-500');
    asset.data.sections.forEach((section, index) => {
      appendAssetText(body, 'h3', `${index + 1}. ${section.label}`);
      appendAssetText(body, 'p', section.narration);
      appendAssetText(body, 'p', `画面：${section.visual_guidance}`, 'text-stone-500');
    });
    appendAssetText(body, 'h3', '给 Agent 的制作指令');
    appendAssetText(body, 'pre', asset.data.agent_prompt, 'whitespace-pre-wrap break-words text-xs leading-relaxed font-sans');
  } else {
    const tree = asset.data.json_tree;
    appendAssetText(body, 'h2', tree.title);
    const list = document.createElement('ul');
    tree.branches.forEach(branch => {
      const item = document.createElement('li');
      appendAssetText(item, 'strong', branch.title);
      const children = document.createElement('ul');
      branch.children.forEach(child => appendAssetText(children, 'li', child));
      item.appendChild(children);
      list.appendChild(item);
    });
    body.appendChild(list);
  }
  document.getElementById('assetResultActions').classList.remove('hidden');
  document.getElementById('assetCopyMarkdownButton').textContent = asset.type === 'production-kit'
    ? '一键复制整套制作包' : '复制 Markdown';
  document.getElementById('assetDownloadMarkdownButton').textContent = asset.type === 'production-kit'
    ? '下载整套制作包' : '下载 Markdown';
  document.getElementById('assetMermaidButton').classList.toggle('hidden', asset.type !== 'mindmap');
  document.getElementById('assetPackageButton').classList.toggle('hidden', asset.type !== 'short-video');
  document.getElementById('assetCopyPromptButton').classList.toggle('hidden', asset.type !== 'production-package');
  const kitSaveButton = document.getElementById('kitProjectSaveButton');
  kitSaveButton.classList.toggle('hidden',
    asset.type !== 'production-kit' || currentUser?.plan !== 'premium');
  kitSaveButton.disabled = Boolean(asset.kitSaved);
  kitSaveButton.textContent = asset.kitSaved ? '已保存到项目' : '保存为创作项目';
  const saveButton = document.getElementById('assetSaveButton');
  saveButton.classList.toggle('hidden', currentUser?.plan !== 'premium' ||
    asset.type === 'production-package' || asset.type === 'production-kit');
  saveButton.disabled = Boolean(asset.savedId);
  saveButton.textContent = asset.savedId ? '已保存' : '保存到资产库';
}

async function refreshAssetUsage() {
  const badge = document.getElementById('assetQuotaBadge');
  document.getElementById('assetLibraryButton').classList.toggle('hidden', currentUser?.plan !== 'premium');
  const canSaveProjects = ['pro', 'premium'].includes(currentUser?.plan);
  document.getElementById('projectListButton').classList.toggle('hidden', !canSaveProjects);
  document.getElementById('projectSaveButton').classList.toggle('hidden', !canSaveProjects);
  if (!token || !currentUser || !['pro', 'premium'].includes(currentUser.plan)) {
    badge.textContent = 'Pro / Premium';
    return;
  }
  try {
    const response = await fetch(`${ADDONS_API_BASE}/api/addons/assets/usage`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return;
    const data = await response.json();
    badge.textContent = `本月剩余 ${data.remaining} / ${data.limit} 次`;
  } catch {
    // 附加服务不可用时保留套餐提示，不影响原有转换界面。
  }
}

async function generateAsset(type) {
  if (!token) return openAuthModal('login');
  if (!currentUser) await checkAuth();
  if (!currentUser || !['pro', 'premium'].includes(currentUser.plan)) return openPricing();

  const rawText = clientCache[activeModalUrl + '::raw'];
  if (!rawText) return showToast('请先打开「原声全文」，等逐字稿载入后再生成');
  if (rawText.length > 40000) return showToast('原声全文超过 4 万字，当前版本请先缩短素材');
  if (activeAssetRequest) return;
  activeAsset = null;

  const platform = type === 'short-video' ? document.getElementById('assetPlatform').value : undefined;
  const sourceUrl = activeModalUrl;
  const labels = {
    xiaohongshu: '小红书图文', 'short-video': '定向口播',
    mindmap: '知识脑图', 'production-kit': '全套制作包'
  };
  openAssetPanel(labels[type]);
  document.getElementById('assetResultBody').textContent = type === 'production-kit'
    ? '正在定制全套制作包（分镜 / 封面 / 图文 / 导图）…' : '正在整理成稿…';
  document.getElementById('assetResultActions').classList.add('hidden');
  document.getElementById('kitProjectSaveButton').classList.add('hidden');
  setAssetBusy(true, type);
  activeAssetRequest = new AbortController();

  try {
    const response = await fetch(`${ADDONS_API_BASE}/api/addons/assets/${type}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        raw_text: rawText,
        ...(platform ? { platform } : {}),
        ...(type === 'production-kit' ? {
          title: activeProjectSourceUrl === sourceUrl ? activeProjectTitle : sourceLabels[sourceUrl] || '',
          source_url: sourceUrl,
          video_id: /^https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})$/.exec(sourceUrl)?.[1] || ''
        } : {})
      }),
      signal: activeAssetRequest.signal
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '创作服务暂不可用');
    if (sourceUrl !== activeModalUrl) return;

    const data = type === 'xiaohongshu' || type === 'production-kit' ? result.data
      : type === 'short-video' ? { script_markdown: result.script_markdown }
      : { json_tree: result.json_tree, mermaid_code: result.mermaid_code };
    if (type === 'production-kit') activeKitTab = 0;
    activeAsset = {
      type,
      platform,
      title: type === 'production-kit' ? '全套制作包'
        : type === 'xiaohongshu' ? data.title
        : type === 'mindmap' ? data.json_tree.title
        : `${ASSET_PLATFORM_LABELS[platform]}口播脚本`,
      data
    };
    rememberAsset(activeAsset, sourceUrl);
    renderAsset(activeAsset);
    document.getElementById('assetQuotaBadge').textContent = `本月剩余 ${result.remaining} 次`;
    if (type !== 'production-kit') await persistAssetToProject(activeAsset, sourceUrl);
    return activeAsset;
  } catch (error) {
    if (error.name === 'AbortError') return;
    document.getElementById('assetResultBody').textContent = error.message || '内容生成未完成，请稍后重试';
    if (/额度/.test(error.message || '')) refreshAssetUsage();
  } finally {
    activeAssetRequest = null;
    setAssetBusy(false);
  }
}

async function createProductionPackage() {
  if (activeAsset?.type !== 'short-video' || activeAssetSourceUrl !== activeModalUrl) {
    return showToast('请先生成当前素材的口播稿');
  }
  const scriptAsset = activeAsset;
  const sourceUrl = activeModalUrl;
  const button = document.getElementById('assetPackageButton');
  button.disabled = true;
  try {
    const response = await fetch(`${ADDONS_API_BASE}/api/addons/assets/production-package`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        script_markdown: scriptAsset.data.script_markdown,
        platform: scriptAsset.platform,
        source_title: activeProjectSourceUrl === sourceUrl ? activeProjectTitle : sourceLabels[sourceUrl] || ''
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '制作包暂未生成');
    if (sourceUrl !== activeModalUrl) return null;
    activeAsset = {
      type: 'production-package', platform: scriptAsset.platform,
      title: `${ASSET_PLATFORM_LABELS[scriptAsset.platform]}视频制作包`, data: result.data
    };
    rememberAsset(activeAsset, sourceUrl);
    renderAsset(activeAsset);
    await persistAssetToProject(activeAsset, sourceUrl);
    return activeAsset;
  } catch (error) {
    showToast(error.message || '制作包暂未生成');
    return null;
  } finally {
    button.disabled = false;
  }
}

async function copyAgentPrompt() {
  if (activeAsset?.type !== 'production-package') return;
  try {
    await navigator.clipboard.writeText(activeAsset.data.agent_prompt);
    showToast('Agent 制作指令已复制');
  } catch { showToast('复制失败，请手动选中制作指令'); }
}

async function copyAssetMarkdown() {
  if (!activeAsset) return;
  try {
    await navigator.clipboard.writeText(assetMarkdown(activeAsset));
    showToast('已复制 Markdown');
  } catch {
    showToast('复制失败，请手动选中文本');
  }
}

function downloadAssetFile(content, extension, mimeType) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `HotCopy_${activeAsset.type}_${Date.now()}.${extension}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function downloadAssetMarkdown() {
  if (activeAsset) downloadAssetFile(assetMarkdown(activeAsset), 'md', 'text/markdown');
}

function downloadAssetMermaid() {
  if (activeAsset?.type === 'mindmap') {
    downloadAssetFile(activeAsset.data.mermaid_code, 'mmd', 'text/plain');
  }
}

function showProjectSave() {
  if (!clientCache[activeModalUrl + '::raw']) return showToast('请先打开原声全文，再保存项目');
  const title = activeProjectSourceUrl === activeModalUrl ? activeProjectTitle
    : sourceLabels[activeModalUrl] || `创作项目 · ${new Date().toLocaleDateString('zh-CN')}`;
  const row = document.getElementById('projectSaveRow');
  document.getElementById('projectTitleInput').value = title.slice(0, 120);
  row.classList.remove('hidden');
  document.getElementById('projectTitleInput').focus();
}

async function persistAssetToProject(asset, sourceUrl = activeModalUrl) {
  if (asset.type === 'production-kit') return true;
  if (!activeProjectId || activeProjectSourceUrl !== sourceUrl) return true;
  try {
    const response = await fetch(`${ADDONS_API_BASE}/api/addons/projects/${activeProjectId}/assets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ asset_type: asset.type, platform: asset.platform || '', content: asset.data })
    });
    if (!response.ok) throw new Error('作品未存入项目');
    return true;
  } catch {
    showToast('项目中的作品未保存成功，请重试保存项目');
    return false;
  }
}

async function saveCurrentProject({ title: suppliedTitle, quiet = false, saveKit = false } = {}) {
  if (!token) return openAuthModal('login');
  if (!currentUser) await checkAuth();
  if (!['pro', 'premium'].includes(currentUser?.plan)) return openPricing();
  const sourceUrl = activeModalUrl;
  const rawText = clientCache[sourceUrl + '::raw'];
  if (!sourceUrl || !rawText) { showToast('请先打开原声全文，再保存项目'); return null; }
  const title = (suppliedTitle || document.getElementById('projectTitleInput').value ||
    sourceLabels[sourceUrl] || '未命名项目').trim().slice(0, 120);
  if (!title) { showToast('请填写项目名称'); return null; }
  const kit = saveKit ? assetDrafts.get(draftKey(sourceUrl, 'production-kit')) : null;
  if (saveKit && (currentUser.plan !== 'premium' || !kit)) {
    showToast('请先以 Premium 会员生成当前素材的全套制作包');
    return null;
  }
  try {
    const response = await fetch(`${ADDONS_API_BASE}/api/addons/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        source_url: sourceUrl, title, raw_text: rawText,
        ...(kit ? { kit_data: kit.data,
          video_id: /^https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})$/.exec(sourceUrl)?.[1] || '' } : {})
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '项目保存失败');
    if (sourceUrl !== activeModalUrl) return null;
    activeProjectId = result.id;
    activeProjectSourceUrl = sourceUrl;
    activeProjectTitle = title;
    sourceLabels[sourceUrl] = title;
    document.getElementById('projectSaveRow').classList.add('hidden');
    document.getElementById('projectSaveButton').textContent = '已保存项目';
    let allSaved = true;
    for (const asset of assetDrafts.values()) {
      if (asset.sourceUrl === sourceUrl) {
        allSaved = await persistAssetToProject(asset, sourceUrl) && allSaved;
      }
    }
    if (!quiet) showToast(allSaved
      ? saveKit ? '全套制作包已保存到项目'
        : currentUser.plan === 'pro' && activeAsset?.type === 'production-kit'
          ? '项目已保存；全套制作包需 Premium 才能存入项目'
          : '项目已保存，可在「我的项目」继续创作'
      : '项目已保存，部分作品需重试');
    return result.id;
  } catch (error) {
    showToast(error.message || '项目保存失败');
    return null;
  }
}

async function saveProductionKitProject() {
  if (activeAsset?.type !== 'production-kit' || activeAssetSourceUrl !== activeModalUrl) return;
  const button = document.getElementById('kitProjectSaveButton');
  button.disabled = true;
  try {
    const id = await saveCurrentProject({
      saveKit: true,
      title: activeProjectSourceUrl === activeModalUrl ? activeProjectTitle
        : sourceLabels[activeModalUrl] || `创作项目 · ${new Date().toLocaleDateString('zh-CN')}`
    });
    if (id) {
      activeAsset.kitSaved = true;
      button.textContent = '已保存到项目';
    }
  } finally { button.disabled = Boolean(activeAsset?.kitSaved); }
}

function projectAssetTitle(asset) {
  if (asset.asset_type === 'production-kit') return '全套制作包';
  if (asset.asset_type === 'production-package') return `${ASSET_PLATFORM_LABELS[asset.platform]}视频制作包`;
  if (asset.asset_type === 'short-video') return `${ASSET_PLATFORM_LABELS[asset.platform]}口播脚本`;
  return asset.asset_type === 'mindmap' ? '知识脑图' : '小红书图文';
}

function renderProjectOverview(project) {
  openAssetPanel(`项目 · ${project.title}`);
  const body = document.getElementById('assetResultBody');
  body.replaceChildren();
  document.getElementById('assetResultActions').classList.add('hidden');
  appendAssetText(body, 'p', `${project.assets.length + (project.kit_data ? 1 : 0)} 份创作资产 · ${project.raw_text ? '原声全文已恢复' : '仅保存了制作包'}`, 'text-xs text-stone-500 mb-3');
  const actions = document.createElement('div');
  actions.className = 'flex flex-wrap gap-2 mb-4';
  for (const [label, type] of [['生成口播', 'short-video'], ['知识脑图', 'mindmap'], ['生成全套制作包', 'production-kit']]) {
    const button = appendAssetText(actions, 'button', label, 'min-h-11 rounded-lg border border-stone-200 bg-white px-3 text-xs');
    button.type = 'button';
    button.disabled = !project.raw_text;
    button.addEventListener('click', () => generateAsset(type));
  }
  body.appendChild(actions);
  if (!project.assets.length && !project.kit_data) appendAssetText(body, 'p', '从上面的创作工具开始，生成后会自动存入这个项目。', 'text-xs text-stone-500');
  if (project.kit_data) {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-3 border-t border-stone-200 py-3';
    appendAssetText(row, 'span', '全套制作包', 'text-sm font-semibold text-stone-800');
    const view = appendAssetText(row, 'button', '查看', 'min-h-11 rounded-lg bg-orange-600 px-3 text-xs text-white');
    view.type = 'button';
    view.addEventListener('click', () => {
      activeAsset = { type: 'production-kit', title: '全套制作包', data: project.kit_data, kitSaved: true };
      rememberAsset(activeAsset, project.source_url);
      activeKitTab = 0;
      renderAsset(activeAsset);
    });
    body.appendChild(row);
  }
  project.assets.forEach(saved => {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-3 border-t border-stone-200 py-3';
    appendAssetText(row, 'span', projectAssetTitle(saved), 'text-sm text-stone-800');
    const view = appendAssetText(row, 'button', '查看', 'min-h-11 rounded-lg bg-stone-900 px-3 text-xs text-white');
    view.type = 'button';
    view.addEventListener('click', () => {
      activeAsset = { type: saved.asset_type, platform: saved.platform || undefined,
        title: projectAssetTitle(saved), data: saved.content };
      rememberAsset(activeAsset, project.source_url);
      if (saved.platform) document.getElementById('assetPlatform').value = saved.platform;
      renderAsset(activeAsset);
    });
    body.appendChild(row);
  });
}

async function openSavedProject(id) {
  try {
    const response = await fetch(`${ADDONS_API_BASE}/api/addons/projects/${id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '项目读取失败');
    const project = result.project;
    activeProjectId = project.id;
    activeProjectSourceUrl = project.source_url;
    activeProjectTitle = project.title;
    sourceLabels[project.source_url] = project.title;
    if (project.raw_text) {
      clientCache[project.source_url + '::raw'] = project.raw_text;
      try { sessionStorage.setItem('hc_client_cache', JSON.stringify(clientCache)); } catch {}
    }
    document.getElementById('videoUrl').value = project.source_url;
    document.getElementById('projectSaveButton').textContent = '已保存项目';
    if (project.raw_text) {
      await runConvertDirect(project.source_url, 'raw');
    } else {
      activeModalUrl = project.source_url;
      document.getElementById('resultModal').classList.remove('hidden');
      document.getElementById('resultText').textContent = '这个项目只保存了制作包。';
    }
    if (activeModalUrl !== project.source_url) return;
    renderProjectOverview(project);
  } catch (error) { showToast(error.message || '项目读取失败'); }
}

async function openProjectList() {
  if (!token) return openAuthModal('login');
  if (!currentUser) await checkAuth();
  if (!['pro', 'premium'].includes(currentUser?.plan)) return openPricing();
  document.getElementById('resultModal').classList.remove('hidden');
  openAssetPanel('我的项目');
  const body = document.getElementById('assetResultBody');
  body.textContent = '正在读取项目…';
  document.getElementById('assetResultActions').classList.add('hidden');
  try {
    const response = await fetch(`${ADDONS_API_BASE}/api/addons/projects`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '项目读取失败');
    body.replaceChildren();
    if (!result.items.length) {
      body.textContent = '还没有项目。打开原声全文后点击「保存项目」，或从雷达开始创作。';
      return;
    }
    result.items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-3 border-b border-stone-200 py-3';
      const summary = document.createElement('div');
      appendAssetText(summary, 'strong', item.title, 'block text-sm text-stone-900');
      appendAssetText(summary, 'span', `${item.asset_count + item.has_kit} 份资产 · ${new Date(item.updated_at).toLocaleDateString('zh-CN')}`, 'text-[11px] text-stone-500');
      const actions = document.createElement('div');
      actions.className = 'flex shrink-0 gap-2';
      const open = appendAssetText(actions, 'button', '继续', 'min-h-11 px-2 text-xs text-orange-700');
      open.type = 'button';
      open.addEventListener('click', () => openSavedProject(item.id));
      const remove = appendAssetText(actions, 'button', '删除', 'min-h-11 px-2 text-xs text-stone-500');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!window.confirm('确定删除这个项目及其中保存的作品吗？')) return;
        try {
          const deleted = await fetch(`${ADDONS_API_BASE}/api/addons/projects/${item.id}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
          });
          if (!deleted.ok) throw new Error();
          row.remove();
          if (activeProjectId === item.id) { activeProjectId = null; activeProjectSourceUrl = ''; activeProjectTitle = ''; }
          showToast('项目已删除');
        } catch { showToast('项目删除失败'); }
      });
      row.append(summary, actions);
      body.appendChild(row);
    });
  } catch (error) { body.textContent = error.message || '项目读取失败'; }
}

async function saveAsset() {
  if (!activeAsset || activeAsset.savedId || currentUser?.plan !== 'premium') return;
  const button = document.getElementById('assetSaveButton');
  button.disabled = true;
  try {
    const response = await fetch(`${ADDONS_API_BASE}/api/addons/assets/library`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ asset_type: activeAsset.type, title: activeAsset.title, content: activeAsset.data })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '保存失败');
    activeAsset.savedId = result.id;
    button.textContent = '已保存';
    showToast('已保存到云端资产库');
  } catch (error) {
    showToast(error.message || '保存失败');
  } finally {
    button.disabled = Boolean(activeAsset?.savedId);
  }
}

async function openAssetLibrary() {
  if (currentUser?.plan !== 'premium') return openPricing();
  cancelAssetGeneration();
  openAssetPanel('我的资产');
  const body = document.getElementById('assetResultBody');
  body.textContent = '正在读取已保存的作品…';
  document.getElementById('assetResultActions').classList.add('hidden');
  try {
    const response = await fetch(`${ADDONS_API_BASE}/api/addons/assets/library`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '资产库暂不可用');
    body.replaceChildren();
    if (!result.items.length) {
      body.textContent = '还没有保存作品。生成后点击「保存到资产库」即可在这里查看。';
      return;
    }
    result.items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-3 py-3 border-b border-stone-200';
      const description = document.createElement('div');
      appendAssetText(description, 'strong', item.title, 'block text-sm text-stone-900');
      appendAssetText(description, 'span', new Date(item.created_at).toLocaleDateString('zh-CN'), 'text-[11px] text-stone-500');
      const actions = document.createElement('div');
      actions.className = 'flex shrink-0 gap-2';
      const view = appendAssetText(actions, 'button', '查看', 'min-h-11 px-2 text-xs text-orange-700');
      view.type = 'button';
      view.addEventListener('click', () => {
        activeAsset = { type: item.asset_type, title: item.title, data: item.content, savedId: item.id };
        renderAsset(activeAsset);
      });
      const remove = appendAssetText(actions, 'button', '删除', 'min-h-11 px-2 text-xs text-stone-500');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!window.confirm('确定删除这份已保存的作品吗？')) return;
        try {
          const deleted = await fetch(`${ADDONS_API_BASE}/api/addons/assets/library/${item.id}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
          });
          if (!deleted.ok) throw new Error('删除失败');
          row.remove();
          showToast('作品已删除');
        } catch { showToast('删除失败，请稍后重试'); }
      });
      row.append(description, actions);
      body.appendChild(row);
    });
  } catch (error) {
    body.textContent = error.message || '资产库暂不可用';
  }
}

document.getElementById('resultTabs').addEventListener('click', closeAssetResult, true);
new MutationObserver(() => {
  const modal = document.getElementById('resultModal');
  if (modal.classList.contains('hidden')) {
    activeAssetRequest?.abort();
    closeAssetResult();
  } else {
    refreshAssetUsage();
  }
}).observe(document.getElementById('resultModal'), { attributes: true, attributeFilter: ['class'] });

let activeRadarCategory = 'all';
let radarRequestVersion = 0;

function formatRadarTime(value) {
  if (!value || !Number.isFinite(Number(value))) return '暂无';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(Number(value)));
}

function renderRadarStatus(data) {
  const element = document.getElementById('radarSyncStatus');
  const count = Number(data.channel_count) || 0;
  const failed = Number(data.failed_channels) || 0;
  if (!data.last_checked_at) {
    element.textContent = `${count} 个频道 · 等待首次抓取`;
    return;
  }
  if (!data.last_success_at) {
    element.textContent = `设定每 ${data.poll_minutes} 分钟检查 · ${count} 个频道 · ${failed ? `${failed} 个来源暂未同步成功` : '等待首次成功同步'}`;
    return;
  }
  const stale = Date.now() - Number(data.last_success_at) > 90 * 60 * 1000;
  element.textContent = `每 ${data.poll_minutes} 分钟检查 · ${count} 个频道 · ${stale ? '最近成功同步' : '最近同步'} ${formatRadarTime(data.last_success_at)}${failed ? ` · ${failed} 个来源更新失败` : ''}${stale ? ' · 更新延迟' : ''}`;
}

function appendRadarText(parent, tagName, value, className = '') {
  const element = document.createElement(tagName);
  element.textContent = value;
  if (className) element.className = className;
  parent.appendChild(element);
  return element;
}

function renderRadarItems(items) {
  const grid = document.getElementById('radarGrid');
  grid.replaceChildren();
  if (!items.length) {
    appendRadarText(grid, 'p', '目前没有成功同步的视频。请查看上方来源状态，稍后再试。', 'text-xs text-stone-500 py-6 sm:col-span-2');
    return;
  }
  items.forEach(item => {
    const card = document.createElement('article');
    card.className = 'overflow-hidden rounded-xl border border-stone-200 bg-[#fafaf9]';
    if (/^https:\/\/i\.ytimg\.com\//.test(item.thumbnail_url || '')) {
      const cover = document.createElement('img');
      cover.src = item.thumbnail_url;
      cover.alt = '';
      cover.loading = 'lazy';
      cover.className = 'h-40 w-full object-cover bg-stone-100';
      card.appendChild(cover);
    }
    const content = document.createElement('div');
    content.className = 'p-4';
    appendRadarText(content, 'p', `${item.channel_name} · ${formatRadarTime(item.published_at)}`, 'text-[11px] text-stone-500 mb-1');
    appendRadarText(content, 'h3', item.title, 'text-sm font-semibold leading-snug text-stone-900 mb-2');
    const age = Date.now() - Number(item.published_at);
    const freshness = age >= 0 && age <= 24 * 60 * 60 * 1000 ? '24 小时内发布' : '已收录';
    const views = Number.isFinite(Number(item.latest_views)) && item.latest_views !== null
      ? ` · 约 ${new Intl.NumberFormat('zh-CN').format(item.latest_views)} 次播放` : '';
    appendRadarText(content, 'p', `${freshness}${views}`, 'text-[11px] text-stone-500 mb-3');
    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap items-center gap-2';
    for (const [label, target] of [['立即制作', 'ready-kit'], ['生成口播', 'short-video'], ['知识脑图', 'mindmap'], ['视频制作包', 'production-package']]) {
      const make = appendRadarText(actions, 'button', label,
        target === 'ready-kit'
          ? 'min-h-11 rounded-lg bg-stone-900 px-3 text-xs font-medium text-white'
          : 'min-h-11 rounded-lg border border-stone-200 bg-white px-3 text-xs font-medium text-stone-800');
      make.type = 'button';
      make.addEventListener('click', () => openRadarVideo(item, target));
    }
    if (/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(item.source_url || '')) {
      const link = appendRadarText(actions, 'a', '查看原视频 ↗', 'text-xs text-stone-600 hover:text-stone-900');
      link.href = item.source_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    content.appendChild(actions);
    card.appendChild(content);
    grid.appendChild(card);
  });
}

async function loadRadar() {
  const version = ++radarRequestVersion;
  const category = activeRadarCategory;
  const status = document.getElementById('radarSyncStatus');
  const grid = document.getElementById('radarGrid');
  status.textContent = '正在查询同步状态';
  grid.textContent = '正在读取已同步的视频…';
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const [statusResponse, inboxResponse] = await Promise.all([
      fetch(`${ADDONS_API_BASE}/api/addons/radar/status`, { headers }),
      fetch(`${ADDONS_API_BASE}/api/addons/radar/inbox?category=${category}`, { headers })
    ]);
    if (version !== radarRequestVersion) return;
    if (statusResponse.status === 403 || inboxResponse.status === 403) {
      openPricing();
      throw new Error('当前会员无法查看雷达');
    }
    if (!statusResponse.ok || !inboxResponse.ok) throw new Error('雷达服务暂不可用');
    const [syncState, inbox] = await Promise.all([statusResponse.json(), inboxResponse.json()]);
    if (version !== radarRequestVersion) return;
    renderRadarStatus(syncState);
    renderRadarItems(Array.isArray(inbox.items) ? inbox.items : []);
  } catch (error) {
    if (version !== radarRequestVersion) return;
    status.textContent = error.message || '同步状态暂不可用';
    grid.textContent = '当前无法读取雷达内容，请稍后重试。';
  }
}

async function openRadar() {
  document.getElementById('radarSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!token) return openAuthModal('login');
  if (!currentUser) await checkAuth();
  if (currentUser?.plan !== 'premium') return openPricing();
  document.getElementById('radarPanel').classList.remove('hidden');
  loadRadar();
}

function switchRadarCategory(category) {
  if (!['all', 'ai', 'tech', 'business', 'growth'].includes(category)) return;
  activeRadarCategory = category;
  document.querySelectorAll('[data-radar-category]').forEach(button => {
    const selected = button.dataset.radarCategory === category;
    button.classList.toggle('bg-stone-900', selected);
    button.classList.toggle('border-stone-900', selected);
    button.classList.toggle('text-white', selected);
    button.classList.toggle('border-stone-200', !selected);
    button.classList.toggle('text-stone-600', !selected);
  });
  loadRadar();
}

async function openRadarVideo(item, target = 'short-video') {
  const sourceUrl = item?.source_url;
  if (!/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(sourceUrl || '')) {
    return showToast('视频链接无效');
  }
  if (radarCreateBusy) return showToast('正在整理上一条素材，请稍候');
  radarCreateBusy = true;
  try {
    document.getElementById('videoUrl').value = sourceUrl;
    document.getElementById('extractor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await runConvertDirect(sourceUrl, 'raw');
    if (activeModalUrl !== sourceUrl || !clientCache[sourceUrl + '::raw']) return;
    const projectId = await saveCurrentProject({ title: item.title || '雷达选题', quiet: true });
    if (!projectId) return;
    if (target === 'ready-kit') {
      document.getElementById('productionKitButton').classList.add('ring-2', 'ring-orange-400');
      showToast('原声全文已就绪，点击「生成全套制作包」');
      return;
    }
    showToast('已建立创作项目，正在生成内容');
    const asset = await generateAsset(target === 'mindmap' ? 'mindmap' : 'short-video');
    if (target === 'production-package' && asset?.type === 'short-video') {
      await createProductionPackage();
    }
  } catch {
    showToast('雷达素材未完成，请稍后重试');
  } finally {
    radarCreateBusy = false;
  }
}
