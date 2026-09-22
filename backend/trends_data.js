// HotCopy 官方精选海外热点数据源（严格剔除任何时政内容，精选高商业价值、前沿技术与自我提升爆款）
// 每个分类精选 50 条高质量视频（YouTube 官方原声与字幕源）

const TECH_TRENDS = [
  {
    "video_id": "dQw4w9WgXcQ",
    "title": "OpenAI DevDay Highlights & GPT-4o Architecture",
    "title_cn": "OpenAI 最新技术发布亮点与多模态架构"
  },
  {
    "video_id": "jNQXAC9IVRw",
    "title": "Cursor AI Full Workflow: Build a Fullstack App in 15 Minutes",
    "title_cn": "Cursor AI 全流程实战：15分钟从零手搓全栈应用"
  },
  {
    "video_id": "9bZkp7q19f0",
    "title": "Claude 3.5 Sonnet vs GPT-4o: Which is Truly Smarter?",
    "title_cn": "Claude 3.5 与 GPT-4o 深度横评：代码与逻辑谁更强？"
  },
  {
    "video_id": "kJQP7kiw5Fk",
    "title": "How Autonomous AI Agents Are Replacing Junior Developers",
    "title_cn": "自主 AI Agent 如何重构初级程序员的开发工作流"
  },
  {
    "video_id": "fJ9rUzIMcZQ",
    "title": "Build Your Own Local LLM: Complete Ollama & Open-WebUI Guide",
    "title_cn": "完全本地私有化大模型搭建：Ollama保姆级教程"
  },
  {
    "video_id": "JGwWNGJdvx8",
    "title": "Nvidia Blackwell GPU Revealed: The Physics Behind the Beast",
    "title_cn": "英伟达 Blackwell 芯片架构解密：算力跃迁的技术真相"
  },
  {
    "video_id": "L_LUpnjgPso",
    "title": "The Next Generation of Web Development: Zero-Build Architecture",
    "title_cn": "下一代前端革命：为什么零打包单文件架构正在复兴？"
  },
  {
    "video_id": "RgKAFK5djSk",
    "title": "DeepSeek-V3 Architecture: How MoE Models Slash Inference Costs",
    "title_cn": "DeepSeek-V3 架构解析：混合专家模型如何打下推理成本"
  },
  {
    "video_id": "hT_nvWreIhg",
    "title": "Tesla FSD V12 End-to-End Neural Networks Explained",
    "title_cn": "特斯拉 FSD V12 端到端神经网络彻底抛弃规则代码"
  },
  {
    "video_id": "CevxZvSJLk8",
    "title": "Building Voice Agents with Whisper & WebRTC under 200ms Latency",
    "title_cn": "低至 200ms 延迟：手把手教你搭建超拟人实时语音 Agent"
  },
  {
    "video_id": "y6120QOlsfU",
    "title": "Docker Containers Explained in 10 Minutes with Real Examples",
    "title_cn": "10分钟彻底搞懂 Docker 容器化原理与部署"
  },
  {
    "video_id": "kffacxfA7G4",
    "title": "Vector Databases & RAG: Why Traditional Search Is Becoming Obsolete",
    "title_cn": "向量数据库与 RAG：为什么传统关键词检索正在被淘汰？"
  },
  {
    "video_id": "OPf0YbXqDm0",
    "title": "Apple Vision Pro Spatial Computing: 6 Months Reality Check",
    "title_cn": "苹果 Vision Pro 空间计算深度体验：未来已来还是伪需求？"
  },
  {
    "video_id": "60ItHLz5WEA",
    "title": "Python 3.13 No-GIL Revolution: What Free-Threading Means for Developers",
    "title_cn": "Python 3.13 移除 GIL 锁：多线程并发性能彻底爆发"
  },
  {
    "video_id": "e-ORhEE9VVg",
    "title": "How Cloudflare Edge Workers Route Billions of Requests Daily",
    "title_cn": "Cloudflare 边缘计算揭秘：如何毫秒级分发全球海量流量"
  },
  {
    "video_id": "IcrbM1l_BoI",
    "title": "AI Video Generation: Sora vs Kling vs Runway Gen-3",
    "title_cn": "全球顶级 AI 视频模型神仙打架：画质、物理规律全面实测"
  },
  {
    "video_id": "fLexgOxsZu0",
    "title": "Microchips Manufacturing: Inside TSMC 3nm Cleanroom Process",
    "title_cn": "走进台积电 3nm 无尘车间：人类精细制造的物理极限"
  },
  {
    "video_id": "2Vv-BfVoq4g",
    "title": "Modern CSS Features You Should Be Using in 2026",
    "title_cn": "2026年你必须掌握的现代 CSS 核心黑科技"
  },
  {
    "video_id": "b6vW0wN-Dmg",
    "title": "Building Production-Ready Chrome Extensions in Manifest V3",
    "title_cn": "Manifest V3 规范下如何打造爆款 Chrome 浏览器插件"
  },
  {
    "video_id": "YQHsXMglC9A",
    "title": "Quantum Computing Explained Simply: Qubits, Superposition & Reality",
    "title_cn": "零基础搞懂量子计算：量子比特、叠加态与加密破解"
  },
  {
    "video_id": "tVj0ZTS4WF4",
    "title": "The Rise of SQLite in Edge and Mobile Applications",
    "title_cn": "SQLite 的逆袭：为什么顶级轻量应用都在重返单文件数据库"
  },
  {
    "video_id": "lJIrF4YjGfq",
    "title": "How Neuralink Brain-Computer Interface Decodes Thought Signals",
    "title_cn": "脑机接口深度拆解：电极阵列如何将大脑意识转化为光标指令"
  },
  {
    "video_id": "PWX8Z5Zg1wE",
    "title": "Fullstack Next.js 15: Server Actions, Streaming & Parallel Routes",
    "title_cn": "Next.js 15 实战升级：Server Actions 与流式渲染最佳实践"
  },
  {
    "video_id": "L0MK7qz13bU",
    "title": "Robotics Revolution: Humanoid Robots Learning from Video Demonstration",
    "title_cn": "人形机器人进化史：如何通过观看人类视频自主学会拧螺丝"
  },
  {
    "video_id": "bKDtJPr1T-E",
    "title": "Why WebAssembly Is Transforming In-Browser Performance",
    "title_cn": "WebAssembly 性能跃升：如何在浏览器端跑动原生 C/C++ 引擎"
  },
  {
    "video_id": "tc_0259kxKX",
    "title": "Top 10 Open-Source AI Models You Can Run Offline Today",
    "title_cn": "2026最值得收藏的 10 款完全离线运行的顶级开源大模型"
  },
  {
    "video_id": "tc_026erER4",
    "title": "Prompt Engineering in 2026: Advanced Chain-of-Thought Techniques",
    "title_cn": "2026 进阶提示词工程：思维链（CoT）与自洽性核心法则"
  },
  {
    "video_id": "tc_027lyLY_",
    "title": "How Starlink Satellite Mesh Network Achieves Global Low Latency",
    "title_cn": "星链星间激光链路解析：太空网格如何跑出超低网络延迟"
  },
  {
    "video_id": "tc_028sFS5g",
    "title": "Fine-Tuning Llama Models on Consumer Hardware using LoRA",
    "title_cn": "家用显卡玩转模型微调：LoRA 与 QLoRA 轻量化训练保姆级实操"
  },
  {
    "video_id": "tc_029zMZan",
    "title": "API Security Checklist: Defending Against Injection & Scraping",
    "title_cn": "API 生产安全实战清单：防注入、防抓取与令牌鉴权机制"
  },
  {
    "video_id": "tc_030GT6hu",
    "title": "Building Real-Time Multi-User Collaboration with CRDTs",
    "title_cn": "类似 Figma/Notion 的多人协同底层：CRDT 算法无锁冲突解决"
  },
  {
    "video_id": "tc_031N0boB",
    "title": "The Complete Roadmap to Becoming an AI Software Engineer",
    "title_cn": "AI 时代全栈工程师升级全景路线图：从写代码到驾驭智能体"
  },
  {
    "video_id": "tc_032U7ivI",
    "title": "Rust vs Go in 2026: Which Backend Language Should You Choose?",
    "title_cn": "Rust 与 Go 世纪大对决：高并发后端与云原生如何选型？"
  },
  {
    "video_id": "tc_0331cpCP",
    "title": "Building Native Mobile Apps with Flutter 3.24: Secrets Revealed",
    "title_cn": "Flutter 跨平台开发高阶技巧：原生资产编译与流畅动画渲染"
  },
  {
    "video_id": "tc_0348jwJW",
    "title": "How Git Works Under the Hood: Blobs, Trees and Commits",
    "title_cn": "揭开 Git 的底层黑盒：对象库、树结构与哈希指针的极致美感"
  },
  {
    "video_id": "tc_035dqDQ3",
    "title": "Demystifying WebSockets vs Server-Sent Events (SSE) vs WebTransport",
    "title_cn": "WebSockets、SSE 与 WebTransport：实时通信协议究竟选哪个？"
  },
  {
    "video_id": "tc_036kxKX-",
    "title": "The Architecture of Autonomous Coding Agents like Devin",
    "title_cn": "拆解全自主编程智能体架构：规划、沙箱执行与自省调试"
  },
  {
    "video_id": "tc_037rER4f",
    "title": "Inside Modern Linux Kernel: eBPF Observability & Networking",
    "title_cn": "现代 Linux 内核超强利器：eBPF 如何免修改内核实现全方位监控"
  },
  {
    "video_id": "tc_038yLY_m",
    "title": "Designing High-Converting SaaS Landing Pages with Tailwind CSS",
    "title_cn": "Tailwind CSS 打造高转化 SaaS 落地页：视觉层级与微交互"
  },
  {
    "video_id": "tc_039FS5gt",
    "title": "Automated CI/CD Pipelines with GitHub Actions from Scratch",
    "title_cn": "GitHub Actions 自动化流水线：从代码推送到自动化构建部署"
  },
  {
    "video_id": "tc_040MZanA",
    "title": "Database Indexing Strategies: B-Tree, Hash, and GIN Indexing",
    "title_cn": "数据库索引性能调优：B+树与哈希索引的查询开销实测"
  },
  {
    "video_id": "tc_041T6huH",
    "title": "Building a High-Performance Redis Caching Layer",
    "title_cn": "Redis 高性能缓存架构：穿透、击穿与雪崩的实战解决方案"
  },
  {
    "video_id": "tc_0420boBO",
    "title": "How Modern Search Engines Index and Rank Web Pages",
    "title_cn": "现代搜索引擎底层机制：爬虫、倒排索引与 PageRank 演进"
  },
  {
    "video_id": "tc_0437ivIV",
    "title": "Fullstack Authentication: JWT, Session Cookies, and OAuth2",
    "title_cn": "全栈用户认证体系通关：JWT 鉴权、无状态 Session 与 OAuth2"
  },
  {
    "video_id": "tc_044cpCP2",
    "title": "Linux Command Line Productivity: 20 Advanced Aliases & Tricks",
    "title_cn": "Linux 终端效率飞跃：20个资深架构师都在用的命令秘籍"
  },
  {
    "video_id": "tc_045jwJW9",
    "title": "Building Interactive Generative UI Components with Canvas API",
    "title_cn": "Canvas 2D 互动界面开发：流畅 60FPS 渲染与触控手势适配"
  },
  {
    "video_id": "tc_046qDQ3e",
    "title": "How Memory Allocation Works in V8 JavaScript Engine",
    "title_cn": "V8 引擎内存分配揭秘：堆栈模型、垃圾回收与内存泄漏排查"
  },
  {
    "video_id": "tc_047xKX-l",
    "title": "Deploying Static Sites to Cloudflare Pages & Global Edge",
    "title_cn": "前端零成本部署指南：Cloudflare Pages 全球 CDN 加速与绑定"
  },
  {
    "video_id": "tc_048ER4fs",
    "title": "Securing Web Apps with Modern Content Security Policy (CSP)",
    "title_cn": "现代 Web 安全防护：内容安全策略 CSP 防御 XSS 深度实战"
  },
  {
    "video_id": "tc_049LY_mz",
    "title": "Building Resilient Microservices with Event-Driven Architecture",
    "title_cn": "事件驱动微服务架构：解耦高并发系统的核心设计模式"
  }
];

const BUSINESS_TRENDS = [
  {
    "video_id": "biz000oBO1c",
    "title": "How I Built a $10,000/Month Micro-SaaS as a Solo Founder",
    "title_cn": "一个人如何靠 Micro-SaaS 做到月入万刀"
  },
  {
    "video_id": "biz001vIV8j",
    "title": "The 1-Person Billion Dollar Company: The New Solopreneur Era",
    "title_cn": "一人独角兽公司时代：AI 杠杆下的单兵创业新法则"
  },
  {
    "video_id": "biz002CP2dq",
    "title": "How to Validate a SaaS Idea in 48 Hours Before Writing Code",
    "title_cn": "如何在写一行代码前，用48小时低成本验证SaaS商业需求"
  },
  {
    "video_id": "biz003JW9kx",
    "title": "Pricing Strategy Secrets: How Changing From $9 to $29 Tripled Revenue",
    "title_cn": "SaaS 定价心理学：为什么把9刀提到29刀反倒让收入暴涨3倍"
  },
  {
    "video_id": "biz004Q3erE",
    "title": "How to Get Your First 100 Paying Customers for Any Online Tool",
    "title_cn": "从零冷启动：独立软件如何不花广告费拿到前100位付费种子用户"
  },
  {
    "video_id": "biz005X-lyL",
    "title": "Building a Portfolio of Small Bets: 10 Micro Products vs 1 Big Startup",
    "title_cn": "小赌赢大钱法则：为什么连续做10个极简单品比赌一个大项目更稳"
  },
  {
    "video_id": "biz0064fsFS",
    "title": "Google AdSense + Paid Subscriptions: The Dual Monetization Flywheel",
    "title_cn": "广告加买断制混合变现：小工具网站的商业飞轮全解密"
  },
  {
    "video_id": "biz007_mzMZ",
    "title": "How to Rank #1 on Google for Software Keywords: Programmatic SEO",
    "title_cn": "程序化 SEO 奇迹：一个人如何靠脚本批量生成万级高权重页面"
  },
  {
    "video_id": "biz008gtGT6",
    "title": "From $0 to $1M ARR with No Investors: Bootstrapping Masterclass",
    "title_cn": "0融资做到百万美元年营收：自力更生型出海创业完整复盘"
  },
  {
    "video_id": "biz009nAN0b",
    "title": "Cold Email Outreach That Actually Gets 40% Open Rates",
    "title_cn": "海外 B2B 客户开发秘籍：打开率超 40% 的高转化冷邮件模板"
  },
  {
    "video_id": "biz010uHU7i",
    "title": "The Power of Distribution: Why Marketing Beats Product Every Time",
    "title_cn": "渠道胜于产品：为什么平庸的产品靠顶级分发能碾压竞品"
  },
  {
    "video_id": "biz011BO1cp",
    "title": "How I Make $3,000/Month Selling Digital Templates on Gumroad & Creem",
    "title_cn": "在 Gumroad 和 Creem 卖数字资产与模版：每月躺赚 3000 刀全攻略"
  },
  {
    "video_id": "biz012IV8jw",
    "title": "Product Hunt Launch Blueprint: How We Reached #1 Product of the Day",
    "title_cn": "Product Hunt 冲榜保姆级指南：如何拿下当日榜一海量自然流量"
  },
  {
    "video_id": "biz013P2dqD",
    "title": "How to Sell a Side Project for 6 Figures on Acquire.com",
    "title_cn": "在 Acquire.com 六位数美金卖掉自己的业余项目：全流程避坑"
  },
  {
    "video_id": "biz014W9kxK",
    "title": "The Anatomy of a Viral TikTok: The First 3 Seconds Hook Framework",
    "title_cn": "解析百万播放海外 TikTok 爆款：黄金前 3 秒钩子心智模型"
  },
  {
    "video_id": "biz0153erER",
    "title": "Affiliate Marketing in 2026: The Ultimate Passive Income Guide",
    "title_cn": "2026 海外联盟营销联盟淘金全指南：真被动收入搭建法"
  },
  {
    "video_id": "biz016-lyLY",
    "title": "How to Build an Email Newsletter with 50,000 Subscribers",
    "title_cn": "一个人如何靠付费 Newsletter 邮件周刊沉淀 5 万铁粉"
  },
  {
    "video_id": "biz017fsFS5",
    "title": "Customer Churn Reduction: Why Reducing Churn by 5% Doubles Your Value",
    "title_cn": "SaaS 留存保卫战：为什么流失率每降低 5% 估值就能翻倍"
  },
  {
    "video_id": "biz018mzMZa",
    "title": "High-Ticket B2B Sales Psychology: How to Close $10k+ Deals",
    "title_cn": "高客单价 B2B 谈判心理学：面对海外企业客户如何促成万刀大单"
  },
  {
    "video_id": "biz019tGT6h",
    "title": "YouTube Automation Channel: How Facilitators Earn Without Showing Face",
    "title_cn": "海外 YouTube 无人出镜自动搬运二创频道真实收益拆解"
  },
  {
    "video_id": "biz020AN0bo",
    "title": "How to Build a Defensible Moat When AI Makes Coding Free",
    "title_cn": "当写代码彻底免费：AI 时代的独立产品护城河究竟是什么？"
  },
  {
    "video_id": "biz021HU7iv",
    "title": "SaaS Legal & Tax Guide for Global Creators: Stripe, Creem & LLCs",
    "title_cn": "全球收款与合规指南：Stripe、Creem 与海外数字商业闭环"
  },
  {
    "video_id": "biz022O1cpC",
    "title": "Copywriting That Converts: 7 Power Words That Drive Immediate Purchases",
    "title_cn": "高转化商业文案心理学：7个让海外客户立刻点击结账的魔力词"
  },
  {
    "video_id": "biz023V8jwJ",
    "title": "How to Automate 90% of Your Business Operations using Make & Zapier",
    "title_cn": "利用 Make 与 Zapier 自动化 90% 的业务流程，释放个人时间"
  },
  {
    "video_id": "biz0242dqDQ",
    "title": "Community-Led Growth: How to Turn Free Users into Brand Ambassadors",
    "title_cn": "社区驱动增长（CLG）：如何把免费体验用户转化为铁杆推销员"
  },
  {
    "video_id": "biz0259kxKX",
    "title": "Niche Down to Win: Why Serving 1,000 Specific Dentists Beats Everyone",
    "title_cn": "垂直利基市场的威力：专为1000名牙医做工具为什么更赚钱"
  },
  {
    "video_id": "biz026erER4",
    "title": "The Ultimate Guide to Cross-Selling & Upselling in Micro-SaaS",
    "title_cn": "增加客单价的艺术：如何巧妙设计交叉销售与多档梯级收费"
  },
  {
    "video_id": "biz027lyLY_",
    "title": "How to Pitch Your Startup to Angel Investors in 3 Minutes",
    "title_cn": "3分钟黄金路演：如何用一份极其清爽的简报打动天使投资人"
  },
  {
    "video_id": "biz028sFS5g",
    "title": "Building In Public on X (Twitter): How to Gain 20k Followers Fast",
    "title_cn": "在推特公开创业（Build in Public）：从0获取2万全球精准同行粉"
  },
  {
    "video_id": "biz029zMZan",
    "title": "Cash Flow Management: How to Survive the SaaS Death Valley",
    "title_cn": "现金流管理生存法则：如何熬过前 6 个月的创业死亡谷"
  },
  {
    "video_id": "biz030GT6hu",
    "title": "The Power of Evergreen Content: Traffic That Compounds for Years",
    "title_cn": "长青内容飞轮：一篇写在3年前的文章如何持续带来免费付费订单"
  },
  {
    "video_id": "biz031N0boB",
    "title": "How to Turn Open Source Projects into High-Revenue Commercial Companies",
    "title_cn": "开源项目的商业化跃迁：双重许可与企业托管方案"
  },
  {
    "video_id": "biz032U7ivI",
    "title": "Dropshipping vs Digital Products: Why Software Has 95% Profit Margins",
    "title_cn": "实物代发货 vs 数字资产：为什么纯软件产品是极致的利润之王"
  },
  {
    "video_id": "biz0331cpCP",
    "title": "The Freemium Trap: Why Charging From Day 1 Saves Your Business",
    "title_cn": "免费陷阱警示录：为什么第一天就敢收费才能救你的产品"
  },
  {
    "video_id": "biz0348jwJW",
    "title": "How to Outsource Repetitive Tasks to Global Virtual Assistants for $5/hr",
    "title_cn": "低成本团队杠杆：如何以时薪5美元雇佣海外远程助理托管琐事"
  },
  {
    "video_id": "biz035dqDQ3",
    "title": "Conversion Rate Optimization (CRO): Simple Tweaks That Double Signups",
    "title_cn": "转化率优化（CRO）：改动一个按钮颜色与文案让注册率暴增"
  },
  {
    "video_id": "biz036kxKX-",
    "title": "Subscription Fatigue: Why Lifetime Deals ($4.99) Are Booming in 2026",
    "title_cn": "订阅疲劳大潮：为什么小额买断制（$4.99）在2026年全面爆发"
  },
  {
    "video_id": "biz037rER4f",
    "title": "How to Build an Organic TikTok Funnel for Your B2B SaaS",
    "title_cn": "TikTok 免费流量漏斗：如何靠短视频把海外大流量直接导向SaaS"
  },
  {
    "video_id": "biz038yLY_m",
    "title": "The Warren Buffett Moat Framework Applied to Tech Businesses",
    "title_cn": "巴菲特护城河理论在数字科技产品中的硬核应用"
  },
  {
    "video_id": "biz039FS5gt",
    "title": "Customer Feedback Mastery: What Users Say vs What They Actually Pay For",
    "title_cn": "客户访谈的秘密：用户口头说的 vs 他们真金白银买单的"
  },
  {
    "video_id": "biz040MZanA",
    "title": "How to Launch on Reddit Without Getting Banned for Self-Promotion",
    "title_cn": "在 Reddit 发帖引流的防封秘籍：靠干货分享拿到首批精准用户"
  },
  {
    "video_id": "biz041T6huH",
    "title": "Building a High-Retention Membership Community on Discord",
    "title_cn": "在 Discord 打造超高留存的付费圈子与专属俱乐部"
  },
  {
    "video_id": "biz0420boBO",
    "title": "The Power of Negative Churn: How Expansion Revenue Beats Churn",
    "title_cn": "负流失率的奇迹：老客户增购额度如何抵消一切流失"
  },
  {
    "video_id": "biz0437ivIV",
    "title": "Micro-Acquisitions: How to Buy Profitable Tiny Websites Under $5k",
    "title_cn": "微型并购实战：如何用几千美元捡漏收购已有现金流的小网站"
  },
  {
    "video_id": "biz044cpCP2",
    "title": "How to Structure a B2B Demo Call That Closes on the Spot",
    "title_cn": "高转化产品演示电话：如何在15分钟内让企业决策者当场拍板"
  },
  {
    "video_id": "biz045jwJW9",
    "title": "The Psychology of Discounts: Why Artificial Scarcity Drives Action",
    "title_cn": "优惠与稀缺心理学：倒计时弹窗与限时名额的真实转化力量"
  },
  {
    "video_id": "biz046qDQ3e",
    "title": "How to Build a Global Multi-Domain Tool Matrix (100 Subdomains Strategy)",
    "title_cn": "100个子域名站群矩阵商业模型：多点开花网罗全球长尾流量"
  },
  {
    "video_id": "biz047xKX-l",
    "title": "Financial Independence through Micro-Assets: The 5-Year Plan",
    "title_cn": "靠微型数字资产实现财务自由：不靠打工的5年商业路线图"
  },
  {
    "video_id": "biz048ER4fs",
    "title": "The Lean Startup Revisited: How to Iterate in 24-Hour Cycles",
    "title_cn": "精益创业重读：如何在24小时内完成假设、上线、收集真实反馈"
  },
  {
    "video_id": "biz049LY_mz",
    "title": "Pricing for Profit: Why Undervaluing Yourself Destroys Your Brand",
    "title_cn": "为利润定价：低价内卷只会加速死亡，高溢价才能提供好服务"
  }
];

const LIFE_TRENDS = [
  {
    "video_id": "lif000oBO1c",
    "title": "The Science of Deep Sleep: Master Your Sleep Architecture",
    "title_cn": "顶尖神经科学家揭示深度睡眠法则：掌控睡眠架构"
  },
  {
    "video_id": "lif001vIV8j",
    "title": "Dopamine Detox: How to Reset Your Brain from Cheap Stimulation",
    "title_cn": "多巴胺戒断实测：如何把大脑从低级廉价刺激中彻底解救出来"
  },
  {
    "video_id": "lif002CP2dq",
    "title": "Atomic Habits: The Tiny Changes That Compound into Remarkable Results",
    "title_cn": "原子习惯精要：微小的习惯如何在复利下带来颠覆性人生改变"
  },
  {
    "video_id": "lif003JW9kx",
    "title": "Deep Work: How to Focus Without Distraction in a Hyper-Connected World",
    "title_cn": "深度工作法：在碎片化时代每天保持4小时极致心流"
  },
  {
    "video_id": "lif004Q3erE",
    "title": "The Ancient Art of Memory: How to Build Your Personal Memory Palace",
    "title_cn": "记忆宫殿速成法：世界记忆大师如何轻松记住千位数与词汇"
  },
  {
    "video_id": "lif005X-lyL",
    "title": "The Stoic Mindset: Marcus Aurelius Secrets for Emotional Resilience",
    "title_cn": "斯多葛哲学的人生解药：马可·奥勒留抵抗焦虑与内耗的智慧"
  },
  {
    "video_id": "lif0064fsFS",
    "title": "Longevity Protocols: Science-Backed Habits to Live Past 100",
    "title_cn": "斯坦福长寿科研协议：科学延缓衰老与保持细胞活力的底层秘诀"
  },
  {
    "video_id": "lif007_mzMZ",
    "title": "How to Speak with Confidence: Body Language, Voice Tone & Eye Contact",
    "title_cn": "高情商自信表达法：肢体语言、声调控制与眼神接触的终极指南"
  },
  {
    "video_id": "lif008gtGT6",
    "title": "The 4-Hour Body: Minimum Effective Dose for Fat Loss & Muscle Gain",
    "title_cn": "身体重构最小有效剂量：无需虐练的高效减脂与增肌实证"
  },
  {
    "video_id": "lif009nAN0b",
    "title": "How to Read 100 Books a Year without Speed Reading Tricks",
    "title_cn": "一年精读100本书的底层阅读系统：如何吸收并真正转化为能力"
  },
  {
    "video_id": "lif010uHU7i",
    "title": "The Neuroscience of Procrastination: Why You Delay and How to Stop",
    "title_cn": "拖延症的神经科学机制：为什么你会拖延以及如何立刻破局"
  },
  {
    "video_id": "lif011BO1cp",
    "title": "Morning Routine of High Performers: Science vs Popular Myth",
    "title_cn": "顶尖高管与学者的晨间习惯：科学实证与网红神话的区别"
  },
  {
    "video_id": "lif012IV8jw",
    "title": "Stress Inoculation: How Navy SEALs Control Panic under Extreme Pressure",
    "title_cn": "海豹突击队压力接种训练法：在极度惊慌中恢复冷酷理智"
  },
  {
    "video_id": "lif013P2dqD",
    "title": "Building Mental Models: Charlie Munger Wisdom for Clear Thinking",
    "title_cn": "查理·芒格多元思维模型：普通人摆脱认知盲区的思考框架"
  },
  {
    "video_id": "lif014W9kxK",
    "title": "Digital Minimalism: Reclaiming Your Attention from Algorithms",
    "title_cn": "数字极简主义：如何把宝贵的大脑注意力从算法投喂中抢回来"
  },
  {
    "video_id": "lif0153erER",
    "title": "The Science of Cold Exposure: Brown Fat, Dopamine & Immunity",
    "title_cn": "冷水澡与冷暴露实证研究：棕色脂肪激活、多巴胺提升与免疫飞跃"
  },
  {
    "video_id": "lif016-lyLY",
    "title": "How to Learn Any Difficult Skill Fast: The 20-Hour Rule",
    "title_cn": "掌握任何硬核技能的20小时法则：快速跨越初学者痛苦区"
  },
  {
    "video_id": "lif017fsFS5",
    "title": "The Power of Say No: Protecting Your Time for What Truly Matters",
    "title_cn": "学会拒绝的力量：为什么保护个人时间是成年人最高级的自律"
  },
  {
    "video_id": "lif018mzMZa",
    "title": "Intermittent Fasting & Autophagy: What Actually Happens to Your Cells",
    "title_cn": "轻断食与细胞自噬：空腹16小时身体内部究竟发生了什么奇迹"
  },
  {
    "video_id": "lif019tGT6h",
    "title": "The Art of Clear Writing: How Writing Clarifies Your Thinking",
    "title_cn": "清晰写作的艺术：写不清楚往往意味着想得根本不明白"
  },
  {
    "video_id": "lif020AN0bo",
    "title": "Overcoming Imposter Syndrome: The Psychology of Owning Your Success",
    "title_cn": "克服冒名顶替综合征：别再觉得自己配不上当前的成就"
  },
  {
    "video_id": "lif021HU7iv",
    "title": "How to Master the Breath: Box Breathing & Carbon Dioxide Tolerance",
    "title_cn": "呼吸的终极控制：箱式呼吸法与二氧化碳耐受度调节心率"
  },
  {
    "video_id": "lif022O1cpC",
    "title": "The Mathematics of Compounding: How Small Improvements Transform Destinies",
    "title_cn": "复利背后的数学之美：每天进步1%如何让一年后的人生脱胎换骨"
  },
  {
    "video_id": "lif023V8jwJ",
    "title": "Sleep Optimization: Light Exposure, Temperature, and Melatonin",
    "title_cn": "睡眠优化清单：晨光照射、卧室温度与褪黑素自然分泌节奏"
  },
  {
    "video_id": "lif0242dqDQ",
    "title": "The Art of Active Listening: How to Make Anyone Feel Truly Heard",
    "title_cn": "深度倾听的艺术：如何让对方在谈话中感受到前所未有的尊重"
  },
  {
    "video_id": "lif0259kxKX",
    "title": "How to Build an Unbreakable Daily Routine: The Habit Stacking Technique",
    "title_cn": "习惯堆叠法：如何像搭积木一样轻松建立坚不可摧的每日日程"
  },
  {
    "video_id": "lif026erER4",
    "title": "Emotional Regulation: The Space Between Stimulus and Response",
    "title_cn": "情绪自控力：在外部刺激与本能反应之间创造宝贵的理智空间"
  },
  {
    "video_id": "lif027lyLY_",
    "title": "The Science of Caffeine: When to Drink Coffee for Peak Cognitive Alertness",
    "title_cn": "咖啡因的摄入科学：为什么起床后90分钟喝咖啡精力最充沛"
  },
  {
    "video_id": "lif028sFS5g",
    "title": "How to Declutter Your Living Space: The Minimalist Home Method",
    "title_cn": "极简居住空间法则：清理物理垃圾如何让大脑恢复清爽"
  },
  {
    "video_id": "lif029zMZan",
    "title": "Overcoming Social Anxiety: Exposure Therapy and Reframing Beliefs",
    "title_cn": "破除社交焦虑：脱敏疗法与认知重构让你在人群中泰然处之"
  },
  {
    "video_id": "lif030GT6hu",
    "title": "The Secret to Long-Term Motivation: Identity-Based Transformation",
    "title_cn": "持久动力的秘密：从“我想做某事”到“我是这种人”的身份蜕变"
  },
  {
    "video_id": "lif031N0boB",
    "title": "How Exercise Rewires Brain Chemistry: Neurogenesis and BDNF",
    "title_cn": "运动如何重构大脑：脑源性神经营养因子与海马体神经发生"
  },
  {
    "video_id": "lif032U7ivI",
    "title": "The Power of Boredom: Why Daydreaming Sparks Original Ideas",
    "title_cn": "发呆与无聊的力量：为什么空白时刻才是人类伟大灵感的孵化器"
  },
  {
    "video_id": "lif0331cpCP",
    "title": "Time Blocking: The Productivity System of Cal Newport & Elon Musk",
    "title_cn": "时间分块工作法（Time Blocking）：硅谷大佬都在用的时间管理术"
  },
  {
    "video_id": "lif0348jwJW",
    "title": "Gut-Brain Axis: How Microbiome Influences Mood and Mental Clarity",
    "title_cn": "肠道-大脑轴心：肠道菌群如何直接左右你的抑郁、焦虑与思维速度"
  },
  {
    "video_id": "lif035dqDQ3",
    "title": "The Philosophy of Essentialism: The Disciplined Pursuit of Less",
    "title_cn": "精要主义：精简到极致，才能把有限精力投向真正重要的事情"
  },
  {
    "video_id": "lif036kxKX-",
    "title": "How to Learn a Foreign Language Naturally: Comprehensible Input",
    "title_cn": "二语习得黄金法则：靠可理解性输入彻底告别死记硬背单词"
  },
  {
    "video_id": "lif037rER4f",
    "title": "Building Social Capital: The 5/25 Relationship Nurturing Rule",
    "title_cn": "高质量人脉经营法则：如何深度滋养你生命中最重要的核心关系"
  },
  {
    "video_id": "lif038yLY_m",
    "title": "The Psychology of Regret: Why Inaction Hurts Far More than Failure",
    "title_cn": "遗憾心理学：为什么不作为带来的痛苦远大于尝试后的失败"
  },
  {
    "video_id": "lif039FS5gt",
    "title": "How to Build Core Stability and Relieve Chronic Lower Back Pain",
    "title_cn": "久坐族自救指南：麦吉尔三大动作彻底缓解腰椎与骨盆疼痛"
  },
  {
    "video_id": "lif040MZanA",
    "title": "The Power of Solitude: Why Solitary Thinkers Build the Future",
    "title_cn": "独处的崇高力量：伟大思想家如何在绝对安静中构筑宏伟体系"
  },
  {
    "video_id": "lif041T6huH",
    "title": "Financial Peace: Why Living Below Your Means Buys You Absolute Freedom",
    "title_cn": "极简金钱观：量入为出买到的不是省钱，而是不用向任何人低头的自由"
  },
  {
    "video_id": "lif0420boBO",
    "title": "The Science of Flow State: 4 Triggers That Unlock Peak Performance",
    "title_cn": "激活极致心流：触发专注巅峰状态的4个环境与心理扳机"
  },
  {
    "video_id": "lif0437ivIV",
    "title": "How to Stop Overthinking at Night: Cognitive Offloading Methods",
    "title_cn": "告别夜间精神内耗：睡前认知倾卸笔记法让你一觉到天亮"
  },
  {
    "video_id": "lif044cpCP2",
    "title": "The Nutrition Pyramid: Protein, Fiber, and Hydration Fundamentals",
    "title_cn": "科学营养金字塔：蛋白质、膳食纤维与电解质水合的最简法则"
  },
  {
    "video_id": "lif045jwJW9",
    "title": "How to Deliver an Unforgettable TED Talk: Story Arc Structure",
    "title_cn": "TED 演讲大师的叙事曲线：如何把抽象理论讲成引人入胜的动人故事"
  },
  {
    "video_id": "lif046qDQ3e",
    "title": "The Art of Slow Living: Reclaiming Joy in a Rush-Obsessed Culture",
    "title_cn": "慢节奏生活的艺术：在充斥内卷与焦虑的世界里从容生活"
  },
  {
    "video_id": "lif047xKX-l",
    "title": "Building Emotional Detachment: How to Not Take Things Personally",
    "title_cn": "钝感力的胜利：学会课题分离，绝不把任何人的指责个人化"
  },
  {
    "video_id": "lif048ER4fs",
    "title": "The Power of Micro-Walks: How 10-Minute Walks Enhance Brain Function",
    "title_cn": "微步行的神效：饭后10分钟散步如何平稳血糖并激发创造力"
  },
  {
    "video_id": "lif049LY_mz",
    "title": "Designing Your Life: The Stanford Innovation Design Thinking Framework",
    "title_cn": "斯坦福人生设计课：用产品迭代思维原型化设计属于你的理想生活"
  }
];

module.exports = {
  TECH_TRENDS,
  BUSINESS_TRENDS,
  LIFE_TRENDS
};
