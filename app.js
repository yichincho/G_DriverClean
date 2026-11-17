/**
 * Google 雲端硬碟與 Gmail 空間清理中心 — 核心應用程式邏輯
 * 包含 OAuth 2.0 認證、使用量分析、Drive 大檔案與天數篩選、Gmail 大信件清理及模擬展示模式
 */

(function () {
  'use strict';

  const STORAGE_KEY_CLIENT_ID = 'gdrive_cleaner_client_id';
  const SESSION_KEY_TOKEN = 'gdrive_cleaner_session_token';
  const SESSION_KEY_EXPIRES = 'gdrive_cleaner_session_expires';
  const DEFAULT_CLIENT_ID = '313760300437-h56nbid8em17b8ahvfubaml6c1opp07p.apps.googleusercontent.com';
  const OAUTH_SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email'
  ].join(' ');

  const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
  const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

  /* ========================================================================
     應用程式集中狀態
     ======================================================================== */
  const state = {
    activeTab: 'dashboard',
    mode: 'guest', // 'guest' | 'demo' | 'google'
    clientId: localStorage.getItem(STORAGE_KEY_CLIENT_ID) || DEFAULT_CLIENT_ID,
    accessToken: null,
    tokenClient: null,
    user: null,
    quota: null,
    folderNameMap: {
      root: '我的雲端硬碟根目錄'
    },
    insights: {
      topFiles: [],
      folderStats: [],
      recommendedFiles: [],
      loading: false
    },
    drive: {
      items: [],
      selectedIds: new Set(),
      nextPageToken: null,
      loading: false
    },
    duplicates: {
      groups: [],
      redundantIds: new Set(),
      keepIds: new Set(),
      redundantBytes: 0,
      scanned: false
    },
    preview: {
      file: null,
      revisions: []
    },
    gmail: {
      items: [],
      selectedIds: new Set(),
      nextPageToken: null,
      loading: false,
      activeSubtab: 'cleaner',
      viewMode: 'grouped',
      collapsedSenders: new Set(),
      subscriptions: [],
      subsLoading: false
    },
    demoStore: {
      quotaLimit: 15 * 1024 * 1024 * 1024,
      otherPhotosBytes: 2.18 * 1024 * 1024 * 1024,
      driveFiles: [],
      gmailMessages: []
    }
  };

  /* ========================================================================
     工具函式：格式化、安全跳脫、天數計算
     ======================================================================== */
  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const num = value / Math.pow(1024, index);
    return `${num >= 100 || index === 0 ? num.toFixed(0) : num.toFixed(2)} ${units[index]}`;
  }

  function calcDaysAgo(isoOrTimestamp) {
    if (!isoOrTimestamp) return 0;
    const ms = typeof isoOrTimestamp === 'number' ? isoOrTimestamp : Date.parse(isoOrTimestamp);
    if (Number.isNaN(ms)) return 0;
    const diff = Date.now() - ms;
    return Math.max(0, Math.floor(diff / 86400000));
  }

  function formatDateDisplay(isoOrTimestamp) {
    const ms = typeof isoOrTimestamp === 'number' ? isoOrTimestamp : Date.parse(isoOrTimestamp);
    if (Number.isNaN(ms)) return '未知日期';
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  }

  function escapeHtml(text) {
    const str = String(text ?? '');
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getFileIconClass(mimeType) {
    if (!mimeType) return 'ph-file';
    if (mimeType.includes('folder')) return 'ph-folder';
    if (mimeType.startsWith('video/')) return 'ph-film-strip';
    if (mimeType.startsWith('image/')) return 'ph-image';
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('compressed') || mimeType.includes('tar')) return 'ph-file-zip';
    if (mimeType.includes('pdf')) return 'ph-file-pdf';
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'ph-file-xls';
    return 'ph-file-text';
  }

  function formatMimeLabel(mimeType) {
    if (!mimeType) return '一般檔案';
    if (mimeType === 'application/vnd.google-apps.folder') return '資料夾';
    if (mimeType.startsWith('video/')) return '影片檔';
    if (mimeType.startsWith('image/')) return '圖片檔';
    if (mimeType.includes('pdf')) return 'PDF 文件';
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z') || mimeType.includes('compressed')) return '壓縮封存檔';
    if (mimeType.includes('google-apps')) return 'Google 文件';
    return '二進位檔案';
  }

  /* ========================================================================
     模擬展示資料產生器（用於免憑證即時體驗）
     ======================================================================== */
  function createDemoDataset() {
    const now = Date.now();
    const dayMs = 86400000;

    state.folderNameMap = {
      root: '我的雲端硬碟根目錄',
      demo_fld_video: '專案歷史影片原始檔_2024',
      demo_fld_backup: '伺服器備份與映像檔歸檔',
      demo_fld_design: '行銷設計原稿與活動RAW圖庫',
      demo_fld_docs: '歷年稽核報表與內部文件'
    };

    const driveFiles = [
      {
        id: 'demo_drv_01',
        name: '2024_產品發表會原始剪輯_4K.mp4',
        mimeType: 'video/mp4',
        size: 3120 * 1048576,
        quotaBytesUsed: 3120 * 1048576,
        modifiedTime: new Date(now - 418 * dayMs).toISOString(),
        viewedByMeTime: new Date(now - 410 * dayMs).toISOString(),
        parents: ['demo_fld_video'],
        trashed: false
      },
      {
        id: 'demo_drv_02',
        name: '公司伺服器完整快照備份_2025Q1.tar.gz',
        mimeType: 'application/x-compressed',
        size: 1640 * 1048576,
        quotaBytesUsed: 1640 * 1048576,
        md5Checksum: 'd41d8cd98f00b204e9800998ecf8427e',
        createdTime: new Date(now - 312 * dayMs).toISOString(),
        modifiedTime: new Date(now - 312 * dayMs).toISOString(),
        viewedByMeTime: new Date(now - 312 * dayMs).toISOString(),
        parents: ['demo_fld_backup'],
        trashed: false
      },
      {
        id: 'demo_drv_dup_01',
        name: '公司伺服器完整快照備份_2025Q1 (1).tar.gz',
        mimeType: 'application/x-compressed',
        size: 1640 * 1048576,
        quotaBytesUsed: 1640 * 1048576,
        md5Checksum: 'd41d8cd98f00b204e9800998ecf8427e',
        createdTime: new Date(now - 340 * dayMs).toISOString(),
        modifiedTime: new Date(now - 340 * dayMs).toISOString(),
        viewedByMeTime: new Date(now - 340 * dayMs).toISOString(),
        parents: ['root'],
        trashed: false
      },
      {
        id: 'demo_drv_rev_01',
        name: '日常營運彙總表.xlsb',
        mimeType: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
        size: 168 * 1048576,
        quotaBytesUsed: 632 * 1048576,
        md5Checksum: '9a0364b9e99bb480dd25e1f0284c8555',
        createdTime: new Date(now - 510 * dayMs).toISOString(),
        modifiedTime: new Date(now - 315 * dayMs).toISOString(),
        viewedByMeTime: new Date(now - 315 * dayMs).toISOString(),
        parents: ['demo_fld_docs'],
        trashed: false
      },
      {
        id: 'demo_drv_03',
        name: '客戶訪談錄影檔_台北場_全片.mov',
        mimeType: 'video/quicktime',
        size: 1340 * 1048576,
        quotaBytesUsed: 1340 * 1048576,
        modifiedTime: new Date(now - 245 * dayMs).toISOString(),
        viewedByMeTime: new Date(now - 238 * dayMs).toISOString(),
        parents: ['demo_fld_video'],
        trashed: false
      },
      {
        id: 'demo_drv_04',
        name: '年度設計素材原稿_PSD與圖庫.zip',
        mimeType: 'application/zip',
        size: 1126 * 1048576,
        quotaBytesUsed: 1126 * 1048576,
        modifiedTime: new Date(now - 526 * dayMs).toISOString(),
        viewedByMeTime: new Date(now - 520 * dayMs).toISOString(),
        parents: ['demo_fld_design'],
        trashed: false
      },
      {
        id: 'demo_drv_05',
        name: '財務報表與稽核掃描彙整_2023.pdf',
        mimeType: 'application/pdf',
        size: 284 * 1048576,
        quotaBytesUsed: 284 * 1048576,
        modifiedTime: new Date(now - 684 * dayMs).toISOString(),
        viewedByMeTime: new Date(now - 680 * dayMs).toISOString(),
        parents: ['demo_fld_docs'],
        trashed: false
      },
      {
        id: 'demo_drv_06',
        name: '東京展覽高畫質相片RAW檔備份.zip',
        mimeType: 'application/zip',
        size: 768 * 1048576,
        quotaBytesUsed: 768 * 1048576,
        modifiedTime: new Date(now - 196 * dayMs).toISOString(),
        viewedByMeTime: new Date(now - 196 * dayMs).toISOString(),
        parents: ['demo_fld_design'],
        trashed: false
      },
      {
        id: 'demo_drv_07',
        name: '軟體測試虛擬機映像檔_Ubuntu.iso',
        mimeType: 'application/octet-stream',
        size: 1420 * 1048576,
        quotaBytesUsed: 1420 * 1048576,
        modifiedTime: new Date(now - 295 * dayMs).toISOString(),
        viewedByMeTime: new Date(now - 290 * dayMs).toISOString(),
        parents: ['demo_fld_backup'],
        trashed: false
      },
      {
        id: 'demo_drv_08',
        name: '教育訓練螢幕錄製_操作教學.mp4',
        mimeType: 'video/mp4',
        size: 315 * 1048576,
        quotaBytesUsed: 315 * 1048576,
        modifiedTime: new Date(now - 42 * dayMs).toISOString(),
        viewedByMeTime: new Date(now - 14 * dayMs).toISOString(),
        parents: ['demo_fld_video'],
        trashed: false
      },
      {
        id: 'demo_drv_09',
        name: '產品型錄印刷用大圖_300DPI.png',
        mimeType: 'image/png',
        size: 124 * 1048576,
        quotaBytesUsed: 124 * 1048576,
        modifiedTime: new Date(now - 154 * dayMs).toISOString(),
        viewedByMeTime: new Date(now - 120 * dayMs).toISOString(),
        parents: ['demo_fld_design'],
        trashed: false
      },
      {
        id: 'demo_drv_10',
        name: '舊版官網靜態備份（已放入垃圾桶）.zip',
        mimeType: 'application/zip',
        size: 680 * 1048576,
        quotaBytesUsed: 680 * 1048576,
        modifiedTime: new Date(now - 280 * dayMs).toISOString(),
        viewedByMeTime: new Date(now - 280 * dayMs).toISOString(),
        parents: ['demo_fld_backup'],
        trashed: true
      },
      {
        id: 'demo_drv_11',
        name: '重複上傳的會議錄影檔（垃圾桶）.mp4',
        mimeType: 'video/mp4',
        size: 462 * 1048576,
        quotaBytesUsed: 462 * 1048576,
        modifiedTime: new Date(now - 19 * dayMs).toISOString(),
        viewedByMeTime: new Date(now - 19 * dayMs).toISOString(),
        parents: ['demo_fld_video'],
        trashed: true
      }
    ];

    const gmailMessages = [
      {
        id: 'demo_gm_01',
        subject: '2024 Q4 平面印刷完稿檔案與字型包（含大型附件）',
        from: '林怡君設計工作室 <studio@example.tw>',
        internalDate: now - 492 * dayMs,
        sizeEstimate: 24.6 * 1048576,
        hasAttachment: true,
        category: 'updates',
        inTrash: false,
        snippet: '您好，附上本季印刷完稿 PDF 與向量圖檔連結，請查收確認版面。'
      },
      {
        id: 'demo_gm_01_b',
        subject: '2025 新版品牌識別規範手冊初稿（附高解析檔案）',
        from: '林怡君設計工作室 <studio@example.tw>',
        internalDate: now - 120 * dayMs,
        sizeEstimate: 16.2 * 1048576,
        hasAttachment: true,
        category: 'updates',
        inTrash: false,
        snippet: '已完成色彩定義與標準字設計規範，請參閱隨信附件草案。'
      },
      {
        id: 'demo_gm_02',
        subject: '台北國際電腦展參展影片花絮原始檔傳送',
        from: '陳志豪 <zhihao.chen@media-partner.tw>',
        internalDate: now - 338 * dayMs,
        sizeEstimate: 19.4 * 1048576,
        hasAttachment: true,
        category: 'updates',
        inTrash: false,
        snippet: '這是昨日現場拍攝的高畫質側錄片段，檔案較大請留意下載。'
      },
      {
        id: 'demo_gm_03',
        subject: '年度軟體授權更新明細與電子發票副本（PDF 附件）',
        from: 'CloudBilling Taiwan <billing@cloudvendor.example>',
        internalDate: now - 265 * dayMs,
        sizeEstimate: 8.7 * 1048576,
        hasAttachment: true,
        category: 'updates',
        inTrash: false,
        snippet: '隨信檢附貴司本年度續約合約書及完整分期對帳明細表。'
      },
      {
        id: 'demo_gm_03_b',
        subject: '雲端主機資源用量即時警報與月結帳單',
        from: 'CloudBilling Taiwan <billing@cloudvendor.example>',
        internalDate: now - 45 * dayMs,
        sizeEstimate: 5.2 * 1048576,
        hasAttachment: true,
        category: 'updates',
        inTrash: false,
        snippet: '系統偵測到上月儲存空間用量即將達到預警上限，請確認月結清單。'
      },
      {
        id: 'demo_gm_04',
        subject: '雲端硬體設備報價單與規格手冊彙整',
        from: '王建宇 <sales@hardware-supply.example>',
        internalDate: now - 210 * dayMs,
        sizeEstimate: 14.2 * 1048576,
        hasAttachment: true,
        category: 'promotions',
        inTrash: false,
        snippet: '感謝詢問，附上伺服器機櫃配置圖與詳細電力負載計算表。'
      },
      {
        id: 'demo_gm_05',
        subject: '週五跨部門簡報投影片定稿與圖表資料',
        from: '張雅婷 <yating@corp-internal.example>',
        internalDate: now - 194 * dayMs,
        sizeEstimate: 11.8 * 1048576,
        hasAttachment: true,
        category: 'updates',
        inTrash: false,
        snippet: '已將圖表重新匯出為高解析度版本，請先預覽第十二頁數據。'
      },
      {
        id: 'demo_gm_06',
        subject: '設計資源平台限時會員電子報與免費素材目錄',
        from: 'Creative Hub Weekly <digest@creativehub.example>',
        internalDate: now - 289 * dayMs,
        sizeEstimate: 6.3 * 1048576,
        hasAttachment: false,
        category: 'promotions',
        inTrash: false,
        snippet: '精選超過五十組字體樣本與網頁排版指南電子書預覽。',
        unsubInfo: {
          httpUrl: 'https://creativehub.example/unsubscribe?id=demo_user',
          mailtoUrl: 'mailto:unsub@creativehub.example?subject=unsubscribe',
          type: 'web'
        }
      },
      {
        id: 'demo_gm_06_b',
        subject: '【黑五特惠】頂級向量字型庫終身買斷促銷通知',
        from: 'Creative Hub Weekly <digest@creativehub.example>',
        internalDate: now - 60 * dayMs,
        sizeEstimate: 7.1 * 1048576,
        hasAttachment: false,
        category: 'promotions',
        inTrash: false,
        snippet: '限時三折特惠即將結束，立即解鎖全站百萬套商用素材授權。',
        unsubInfo: {
          httpUrl: 'https://creativehub.example/unsubscribe?id=demo_user',
          type: 'web'
        }
      },
      {
        id: 'demo_gm_07',
        subject: '開發者社群年度技術回顧摘要與討論串備份',
        from: 'TechForum Digest <no-reply@techforum.example>',
        internalDate: now - 405 * dayMs,
        sizeEstimate: 5.4 * 1048576,
        hasAttachment: false,
        category: 'social',
        inTrash: false,
        snippet: '您追蹤的議題本週新增四十二則回覆與完整測試報告。',
        unsubInfo: {
          mailtoUrl: 'mailto:unsub@techforum.example?subject=unsubscribe_user',
          type: 'mail'
        }
      },
      {
        id: 'demo_gm_07_b',
        subject: 'TechForum 每週精選：前端框架效能調校指南',
        from: 'TechForum Digest <no-reply@techforum.example>',
        internalDate: now - 180 * dayMs,
        sizeEstimate: 4.8 * 1048576,
        hasAttachment: false,
        category: 'social',
        inTrash: false,
        snippet: '本週社群熱門討論文章彙整，包含伺服器渲染最佳化實戰技巧。',
        unsubInfo: {
          mailtoUrl: 'mailto:unsub@techforum.example?subject=unsubscribe_user',
          type: 'mail'
        }
      },
      {
        id: 'demo_gm_08',
        subject: '舊系統資料庫匯出紀錄通知（已移入垃圾桶）',
        from: 'System Monitor <alert@ops-monitor.example>',
        internalDate: now - 24 * dayMs,
        sizeEstimate: 16.5 * 1048576,
        hasAttachment: true,
        category: 'updates',
        inTrash: true,
        snippet: '自動排程已完成資料表匯出與壓縮封存，請確認保留期限。'
      },
      {
        id: 'demo_gm_09',
        subject: 'Shopee 蝦皮購物：週末全站免運券與狂歡優惠已入帳',
        from: 'Shopee 蝦皮購物 <promotions@shopee.tw>',
        internalDate: now - 35 * dayMs,
        sizeEstimate: 5.9 * 1048576,
        hasAttachment: false,
        category: 'promotions',
        inTrash: false,
        snippet: '您專屬的免運折扣券已發送至帳戶，立即前往搶購指定熱門商品。',
        unsubInfo: {
          httpUrl: 'https://shopee.tw/unsubscribe?token=demo_token_123',
          type: 'web'
        }
      },
      {
        id: 'demo_gm_09_b',
        subject: 'Shopee 蝦皮購物：您購物車內的商品即將降價！',
        from: 'Shopee 蝦皮購物 <promotions@shopee.tw>',
        internalDate: now - 14 * dayMs,
        sizeEstimate: 4.5 * 1048576,
        hasAttachment: false,
        category: 'promotions',
        inTrash: false,
        snippet: '關注商品限時降價中，滿額再享超商取貨免運費優惠。',
        unsubInfo: {
          httpUrl: 'https://shopee.tw/unsubscribe?token=demo_token_123',
          type: 'web'
        }
      },
      {
        id: 'demo_gm_10',
        subject: 'Uber & Uber Eats：專屬乘車折抵金與美味外送推薦',
        from: 'Uber Taiwan <support@uber.com>',
        internalDate: now - 52 * dayMs,
        sizeEstimate: 4.8 * 1048576,
        hasAttachment: false,
        category: 'promotions',
        inTrash: false,
        snippet: '這週末搭車輸入專屬優惠序號即可享 85 折優惠，隨點隨叫美味到家。',
        unsubInfo: {
          httpUrl: 'https://mail.uber.com/unsub?id=demo_uber_sub',
          type: 'web'
        }
      },
      {
        id: 'demo_gm_11',
        subject: 'GitHub Notifications：New releases and repository updates',
        from: 'GitHub <notifications@github.com>',
        internalDate: now - 85 * dayMs,
        sizeEstimate: 6.2 * 1048576,
        hasAttachment: false,
        category: 'social',
        inTrash: false,
        snippet: 'You have 12 unread notifications for repositories you watch.',
        unsubInfo: {
          httpUrl: 'https://github.com/settings/notifications',
          type: 'web'
        }
      }
    ];

    state.demoStore.driveFiles = driveFiles;
    state.demoStore.gmailMessages = gmailMessages;
  }

  /* ========================================================================
     DOM 元素索引
     ======================================================================== */
  const el = {
    protocolWarningBanner: document.getElementById('protocolWarningBanner'),
    navStatusDot: document.getElementById('navStatusDot'),
    navStatusText: document.getElementById('navStatusText'),
    navAuthActionBtn: document.getElementById('navAuthActionBtn'),
    mobileMenuToggleBtn: document.getElementById('mobileMenuToggleBtn'),
    mobileMenuCloseBtn: document.getElementById('mobileMenuCloseBtn'),
    mobileDrawer: document.getElementById('mobileDrawer'),
    mobileAuthActionBtn: document.getElementById('mobileAuthActionBtn'),

    globalToastContainer: document.getElementById('globalToastContainer'),
    globalToastBox: document.getElementById('globalToastBox'),
    globalToastIcon: document.getElementById('globalToastIcon'),
    globalToastText: document.getElementById('globalToastText'),
    globalToastCloseBtn: document.getElementById('globalToastCloseBtn'),

    heroLoginBtn: document.getElementById('heroLoginBtn'),
    heroDemoBtn: document.getElementById('heroDemoBtn'),
    heroAuthHint: document.getElementById('heroAuthHint'),
    accountModeBadge: document.getElementById('accountModeBadge'),
    userAvatarPlaceholder: document.getElementById('userAvatarPlaceholder'),
    userAvatarImg: document.getElementById('userAvatarImg'),
    userDisplayName: document.getElementById('userDisplayName'),
    userEmailText: document.getElementById('userEmailText'),
    quickClientIdInput: document.getElementById('quickClientIdInput'),
    quickSaveClientIdBtn: document.getElementById('quickSaveClientIdBtn'),
    quickClientIdFeedback: document.getElementById('quickClientIdFeedback'),
    signedInActionRow: document.getElementById('signedInActionRow'),
    refreshQuotaBtn: document.getElementById('refreshQuotaBtn'),
    signOutBtn: document.getElementById('signOutBtn'),

    quotaSourceLabel: document.getElementById('quotaSourceLabel'),
    quotaUsedBig: document.getElementById('quotaUsedBig'),
    quotaLimitBig: document.getElementById('quotaLimitBig'),
    quotaPercentLabel: document.getElementById('quotaPercentLabel'),
    barDriveSegment: document.getElementById('barDriveSegment'),
    barTrashSegment: document.getElementById('barTrashSegment'),
    barGmailSegment: document.getElementById('barGmailSegment'),
    statDriveUsage: document.getElementById('statDriveUsage'),
    statDriveTrash: document.getElementById('statDriveTrash'),
    statGmailOther: document.getElementById('statGmailOther'),
    statFreeSpace: document.getElementById('statFreeSpace'),

    liveStorageVisualizer: document.getElementById('liveStorageVisualizer'),
    liveGapStatusPill: document.getElementById('liveGapStatusPill'),
    svgOuterArc: document.getElementById('svgOuterArc'),
    svgInnerArc: document.getElementById('svgInnerArc'),
    svgTargetMarker: document.getElementById('svgTargetMarker'),
    gaugeCenterPct: document.getElementById('gaugeCenterPct'),
    gaugeCenterSub: document.getElementById('gaugeCenterSub'),
    liveRulerCaption: document.getElementById('liveRulerCaption'),
    liveTargetLineLabel: document.getElementById('liveTargetLineLabel'),
    liveReserveZone: document.getElementById('liveReserveZone'),
    liveBarDrive: document.getElementById('liveBarDrive'),
    liveBarTrash: document.getElementById('liveBarTrash'),
    liveBarGmail: document.getElementById('liveBarGmail'),
    liveTargetLine: document.getElementById('liveTargetLine'),
    liveProjectedText: document.getElementById('liveProjectedText'),
    liveProjectedBar: document.getElementById('liveProjectedBar'),
    liveProjectedTargetLine: document.getElementById('liveProjectedTargetLine'),
    liveCurrentUsageVal: document.getElementById('liveCurrentUsageVal'),
    liveTargetCapVal: document.getElementById('liveTargetCapVal'),
    liveGapDiffVal: document.getElementById('liveGapDiffVal'),
    liveSelectedReleaseVal: document.getElementById('liveSelectedReleaseVal'),
    liveTargetModeSelect: document.getElementById('liveTargetModeSelect'),
    liveReserveSlider: document.getElementById('liveReserveSlider'),
    liveReservePctLabel: document.getElementById('liveReservePctLabel'),

    countdown1224Label: document.getElementById('countdown1224Label'),
    autoSelectTargetBtn: document.getElementById('autoSelectTargetBtn'),
    targetPlanSelect: document.getElementById('targetPlanSelect'),
    customTargetGbWrap: document.getElementById('customTargetGbWrap'),
    customTargetGbInput: document.getElementById('customTargetGbInput'),
    reservePercentSelect: document.getElementById('reservePercentSelect'),
    targetSafeCapDisplay: document.getElementById('targetSafeCapDisplay'),
    targetCurrentRatioText: document.getElementById('targetCurrentRatioText'),
    targetCurrentRatioSub: document.getElementById('targetCurrentRatioSub'),
    targetReserveBytesText: document.getElementById('targetReserveBytesText'),
    targetDeficitText: document.getElementById('targetDeficitText'),
    targetDeficitSub: document.getElementById('targetDeficitSub'),
    refreshInsightsBtn: document.getElementById('refreshInsightsBtn'),
    planASizeBadge: document.getElementById('planASizeBadge'),
    planBSizeBadge: document.getElementById('planBSizeBadge'),
    planCSizeBadge: document.getElementById('planCSizeBadge'),
    folderRankingList: document.getElementById('folderRankingList'),
    unusedLargeFilesList: document.getElementById('unusedLargeFilesList'),

    driveSizeFilter: document.getElementById('driveSizeFilter'),
    driveCustomSizeWrap: document.getElementById('driveCustomSizeWrap'),
    driveCustomSizeInput: document.getElementById('driveCustomSizeInput'),
    driveDaysFilter: document.getElementById('driveDaysFilter'),
    driveCustomDaysWrap: document.getElementById('driveCustomDaysWrap'),
    driveCustomDaysInput: document.getElementById('driveCustomDaysInput'),
    driveTypeFilter: document.getElementById('driveTypeFilter'),
    driveScopeFilter: document.getElementById('driveScopeFilter'),
    driveSortSelect: document.getElementById('driveSortSelect'),
    driveFolderFilter: document.getElementById('driveFolderFilter'),
    driveSearchInput: document.getElementById('driveSearchInput'),
    driveApplyFilterBtn: document.getElementById('driveApplyFilterBtn'),
    dupSummaryBadge: document.getElementById('dupSummaryBadge'),
    scanDuplicatesBtn: document.getElementById('scanDuplicatesBtn'),
    selectOldDuplicatesBtn: document.getElementById('selectOldDuplicatesBtn'),
    driveFolderNavBar: document.getElementById('driveFolderNavBar'),
    driveCurrentFolderLabel: document.getElementById('driveCurrentFolderLabel'),
    driveOpenFolderExternalLink: document.getElementById('driveOpenFolderExternalLink'),
    driveExitFolderBtn: document.getElementById('driveExitFolderBtn'),
    driveSelectAllCheckbox: document.getElementById('driveSelectAllCheckbox'),
    driveTotalCount: document.getElementById('driveTotalCount'),
    driveSelectedCount: document.getElementById('driveSelectedCount'),
    driveSelectedSize: document.getElementById('driveSelectedSize'),
    driveBatchTrashBtn: document.getElementById('driveBatchTrashBtn'),
    driveBatchDeleteBtn: document.getElementById('driveBatchDeleteBtn'),
    driveEmptyTrashBtn: document.getElementById('driveEmptyTrashBtn'),
    driveTableBody: document.getElementById('driveTableBody'),
    drivePaginationWrap: document.getElementById('drivePaginationWrap'),
    driveLoadMoreBtn: document.getElementById('driveLoadMoreBtn'),

    gmailQueryPreview: document.getElementById('gmailQueryPreview'),
    gmailSizeFilter: document.getElementById('gmailSizeFilter'),
    gmailCustomSizeWrap: document.getElementById('gmailCustomSizeWrap'),
    gmailCustomSizeInput: document.getElementById('gmailCustomSizeInput'),
    gmailDaysFilter: document.getElementById('gmailDaysFilter'),
    gmailCustomDaysWrap: document.getElementById('gmailCustomDaysWrap'),
    gmailCustomDaysInput: document.getElementById('gmailCustomDaysInput'),
    gmailCategoryFilter: document.getElementById('gmailCategoryFilter'),
    gmailSortSelect: document.getElementById('gmailSortSelect'),
    gmailSearchInput: document.getElementById('gmailSearchInput'),
    gmailApplyFilterBtn: document.getElementById('gmailApplyFilterBtn'),
    gmailSelectAllCheckbox: document.getElementById('gmailSelectAllCheckbox'),
    gmailTotalCount: document.getElementById('gmailTotalCount'),
    gmailSelectedCount: document.getElementById('gmailSelectedCount'),
    gmailSelectedSize: document.getElementById('gmailSelectedSize'),
    gmailBatchTrashBtn: document.getElementById('gmailBatchTrashBtn'),
    gmailBatchDeleteBtn: document.getElementById('gmailBatchDeleteBtn'),
    gmailSubtabCleanerBtn: document.getElementById('gmailSubtabCleanerBtn'),
    gmailSubtabSubscriptionsBtn: document.getElementById('gmailSubtabSubscriptionsBtn'),
    gmailCleanerPanel: document.getElementById('gmailCleanerPanel'),
    gmailSubscriptionsPanel: document.getElementById('gmailSubscriptionsPanel'),
    gmailViewModeGroupedBtn: document.getElementById('gmailViewModeGroupedBtn'),
    gmailViewModeFlatBtn: document.getElementById('gmailViewModeFlatBtn'),
    gmailExpandAllBtn: document.getElementById('gmailExpandAllBtn'),
    gmailCollapseAllBtn: document.getElementById('gmailCollapseAllBtn'),
    gmailGroupedWrap: document.getElementById('gmailGroupedWrap'),
    gmailGroupedContainer: document.getElementById('gmailGroupedContainer'),
    gmailFlatWrap: document.getElementById('gmailFlatWrap'),
    subScanBtn: document.getElementById('subScanBtn'),
    subStatsTotalCount: document.getElementById('subStatsTotalCount'),
    subStatsMessageCount: document.getElementById('subStatsMessageCount'),
    subStatsTotalBytes: document.getElementById('subStatsTotalBytes'),
    subStatsUnsubCount: document.getElementById('subStatsUnsubCount'),
    subTableBody: document.getElementById('subTableBody'),
    gmailTableBody: document.getElementById('gmailTableBody'),
    gmailPaginationWrap: document.getElementById('gmailPaginationWrap'),
    gmailLoadMoreBtn: document.getElementById('gmailLoadMoreBtn'),

    guideClientIdInput: document.getElementById('guideClientIdInput'),
    guideSaveClientIdBtn: document.getElementById('guideSaveClientIdBtn'),
    guideLoginNowBtn: document.getElementById('guideLoginNowBtn'),
    guideClientIdFeedback: document.getElementById('guideClientIdFeedback'),

    confirmModalBackdrop: document.getElementById('confirmModalBackdrop'),
    confirmModalTitle: document.getElementById('confirmModalTitle'),
    confirmModalSubtitle: document.getElementById('confirmModalSubtitle'),
    confirmModalBody: document.getElementById('confirmModalBody'),
    confirmModalCloseBtn: document.getElementById('confirmModalCloseBtn'),
    confirmModalCancelBtn: document.getElementById('confirmModalCancelBtn'),
    confirmModalExecuteBtn: document.getElementById('confirmModalExecuteBtn'),
    confirmProgressWrap: document.getElementById('confirmProgressWrap'),
    confirmProgressLabel: document.getElementById('confirmProgressLabel'),
    confirmProgressCount: document.getElementById('confirmProgressCount'),
    confirmProgressBar: document.getElementById('confirmProgressBar'),

    infoModalBackdrop: document.getElementById('infoModalBackdrop'),
    infoModalTitle: document.getElementById('infoModalTitle'),
    infoModalContent: document.getElementById('infoModalContent'),
    infoModalCloseBtn: document.getElementById('infoModalCloseBtn'),
    infoModalConfirmBtn: document.getElementById('infoModalConfirmBtn'),
    openPrivacyModalBtn: document.getElementById('openPrivacyModalBtn'),
    openTermsModalBtn: document.getElementById('openTermsModalBtn'),

    filePreviewModalBackdrop: document.getElementById('filePreviewModalBackdrop'),
    previewModalIcon: document.getElementById('previewModalIcon'),
    previewModalTitle: document.getElementById('previewModalTitle'),
    previewModalSubtitle: document.getElementById('previewModalSubtitle'),
    previewModalCloseBtn: document.getElementById('previewModalCloseBtn'),
    previewFrameContainer: document.getElementById('previewFrameContainer'),
    previewOpenDriveBtn: document.getElementById('previewOpenDriveBtn'),
    previewEnterFolderBtn: document.getElementById('previewEnterFolderBtn'),
    previewQuotaSize: document.getElementById('previewQuotaSize'),
    previewLatestSize: document.getElementById('previewLatestSize'),
    previewFolderName: document.getElementById('previewFolderName'),
    previewCreatedTime: document.getElementById('previewCreatedTime'),
    previewModifiedTime: document.getElementById('previewModifiedTime'),
    previewRevisionCountBadge: document.getElementById('previewRevisionCountBadge'),
    previewRevisionsList: document.getElementById('previewRevisionsList'),
    previewCleanOldRevisionsBtn: document.getElementById('previewCleanOldRevisionsBtn'),
    previewWorkflowDiagnosis: document.getElementById('previewWorkflowDiagnosis'),
    previewRebuildCleanBtn: document.getElementById('previewRebuildCleanBtn'),
    previewRevisionStatusBox: document.getElementById('previewRevisionStatusBox'),
    previewRevStatusText: document.getElementById('previewRevStatusText'),
    previewRevProgressCount: document.getElementById('previewRevProgressCount'),
    previewRevProgressBar: document.getElementById('previewRevProgressBar'),
    previewRevErrorDetail: document.getElementById('previewRevErrorDetail'),
    previewReauthBtn: document.getElementById('previewReauthBtn'),
    previewTrashFileBtn: document.getElementById('previewTrashFileBtn'),
    previewDeleteFileBtn: document.getElementById('previewDeleteFileBtn')
  };

  /* ========================================================================
     UI 通知與分頁管理
     ======================================================================== */
  let toastTimer = null;

  function showToast(message, type = 'info') {
    const iconMap = {
      info: { cls: 'ph-info text-[#3B82F6]', border: '#313131' },
      success: { cls: 'ph-check-circle text-[#10B981]', border: '#065F46' },
      warning: { cls: 'ph-warning-circle text-[#F59E0B]', border: '#78350F' },
      error: { cls: 'ph-x-circle text-[#EF4444]', border: '#7F1D1D' }
    };
    const cfg = iconMap[type] || iconMap.info;
    el.globalToastIcon.className = `ph ${cfg.cls} text-xl shrink-0`;
    el.globalToastBox.style.borderColor = cfg.border;
    el.globalToastText.textContent = message;
    el.globalToastContainer.classList.remove('hidden');

    if (toastTimer) clearTimeout(toastTimer);
    if (type !== 'error' && type !== 'warning') {
      toastTimer = setTimeout(() => {
        el.globalToastContainer.classList.add('hidden');
      }, 6500);
    }
  }

  async function withButtonBusy(btn, busyLabel, asyncFn) {
    if (!btn) return asyncFn();
    const origHtml = btn.innerHTML;
    const origDisabled = btn.disabled;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.innerHTML = `<i class="ph ph-spinner text-base" aria-hidden="true"></i><span>${escapeHtml(busyLabel)}</span>`;
    try {
      return await asyncFn();
    } finally {
      btn.classList.remove('is-busy');
      btn.innerHTML = origHtml;
      btn.disabled = origDisabled;
    }
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
      if (panel.dataset.tabPanel === tabName) {
        panel.classList.remove('hidden');
      } else {
        panel.classList.add('hidden');
      }
    });

    document.querySelectorAll('[data-nav-target]').forEach((btn) => {
      if (btn.classList.contains('nav-link-btn')) {
        const isCurrent = btn.dataset.navTarget === tabName;
        btn.classList.toggle('is-active', isCurrent);
        btn.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
      }
    });

    if (el.liveStorageVisualizer) {
      el.liveStorageVisualizer.classList.toggle('hidden', tabName === 'guide');
    }

    closeMobileDrawer();
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (tabName === 'drive' && state.mode !== 'guest' && state.drive.items.length === 0) {
      loadDriveFiles(false);
    }
    if (tabName === 'gmail' && state.mode !== 'guest' && state.gmail.items.length === 0) {
      loadGmailMessages(false);
    }
  }

  function openMobileDrawer() {
    el.mobileDrawer.classList.add('is-open');
    el.mobileDrawer.setAttribute('aria-hidden', 'false');
    el.mobileMenuToggleBtn.setAttribute('aria-expanded', 'true');
    const items = el.mobileDrawer.querySelectorAll('.mobile-drawer-item');
    items.forEach((item, index) => {
      item.style.transitionDelay = `${Math.min(index * 60, 400)}ms`;
    });
  }

  function closeMobileDrawer() {
    el.mobileDrawer.classList.remove('is-open');
    el.mobileDrawer.setAttribute('aria-hidden', 'true');
    el.mobileMenuToggleBtn.setAttribute('aria-expanded', 'false');
  }

  /* ========================================================================
     Client ID 管理與 OAuth 2.0 登入
     ======================================================================== */
  function syncClientIdInputs() {
    el.quickClientIdInput.value = state.clientId;
    el.guideClientIdInput.value = state.clientId;

    if (state.clientId) {
      el.heroAuthHint.textContent = '已儲存您的 Google OAuth Client ID，點擊「登入 Google 帳號並載入空間」即可開始授權連線。';
    } else {
      el.heroAuthHint.textContent = '尚未設定 Google OAuth 2.0 Client ID。可先點擊「進入模擬展示模式體驗」測試流程，或開啟登入教學完成設定。';
    }
  }

  function saveClientId(rawValue, feedbackTarget) {
    const cleaned = (rawValue || '').trim();
    if (!cleaned) {
      state.clientId = '';
      localStorage.removeItem(STORAGE_KEY_CLIENT_ID);
      syncClientIdInputs();
      if (feedbackTarget) feedbackTarget.textContent = '已清除儲存的 Client ID。';
      showToast('已清除本地儲存的 Google Client ID。', 'info');
      return false;
    }

    if (!cleaned.includes('.apps.googleusercontent.com')) {
      const msg = '格式不正確，Google OAuth Client ID 結尾通常為 .apps.googleusercontent.com。';
      if (feedbackTarget) {
        feedbackTarget.textContent = msg;
        feedbackTarget.style.color = '#FCA5A5';
      }
      showToast(msg, 'error');
      return false;
    }

    state.clientId = cleaned;
    state.tokenClient = null;
    localStorage.setItem(STORAGE_KEY_CLIENT_ID, cleaned);
    syncClientIdInputs();

    const okMsg = '已成功儲存 Client ID 至本機瀏覽器，現在可以點擊登入 Google 帳號。';
    if (feedbackTarget) {
      feedbackTarget.textContent = okMsg;
      feedbackTarget.style.color = '#10B981';
    }
    showToast(okMsg, 'success');
    return true;
  }

  function startGoogleLogin(forceConsent = false) {
    if (window.location.protocol === 'file:') {
      showToast('無法於 file 通訊協定登入 Google，請執行「啟動雲端清理工具.bat」並開啟 http://localhost:8080。', 'warning');
      switchTab('guide');
      return;
    }

    if (!state.clientId) {
      showToast('請先在「登入教學」頁面設定並儲存您的 Google OAuth Client ID。', 'warning');
      switchTab('guide');
      el.guideClientIdInput.focus();
      return;
    }

    if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      showToast('Google Identity Services SDK 尚未載入完成，請確認網路連線後重新整理頁面。', 'error');
      return;
    }

    if (!state.tokenClient) {
      // 不傳入 error_callback，避免 gsi/client 因 COOP 跨頁檢查觸發 500ms popup_closed 誤判
      state.tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: state.clientId,
        scope: OAUTH_SCOPES,
        callback: handleOAuthTokenResponse
      });
    }

    const isForced = forceConsent === true;
    showToast(
      isForced
        ? '正在重新開啟 Google 授權視窗，請確認勾選全部「雲端硬碟」編輯與刪除權限後點擊「繼續」。'
        : '正在開啟 Google 授權視窗，請於彈出視窗選擇帳號並點擊「繼續」。',
      'info'
    );
    state.tokenClient.requestAccessToken({ prompt: isForced ? 'consent' : '' });
  }

  async function handleOAuthTokenResponse(tokenResponse) {
    if (!tokenResponse) return;
    if (tokenResponse.error) {
      const errMsg = `Google 授權失敗：${tokenResponse.error_description || tokenResponse.error}`;
      showToast(errMsg, 'error');
      el.heroAuthHint.textContent = errMsg;
      return;
    }

    if (!tokenResponse.access_token) {
      showToast('未收到 Google Access Token，請再試一次並確認有勾選授權項目。', 'warning');
      return;
    }

    if (tokenResponse.access_token === state.accessToken && state.mode === 'google') {
      return;
    }

    state.accessToken = tokenResponse.access_token;
    state.mode = 'google';
    const expiresSec = Math.max(120, Number(tokenResponse.expires_in || 3500) - 60);
    try {
      sessionStorage.setItem(SESSION_KEY_TOKEN, tokenResponse.access_token);
      sessionStorage.setItem(SESSION_KEY_EXPIRES, String(Date.now() + expiresSec * 1000));
    } catch {
      // 忽略 sessionStorage 限制
    }
    state.drive.items = [];
    state.drive.selectedIds.clear();
    state.gmail.items = [];
    state.gmail.selectedIds.clear();

    updateAuthUI();
    showToast('已成功取得 Google 授權，正在讀取您的帳號空間與清單資料。', 'success');

    await Promise.all([fetchGoogleUserInfo(), loadStorageQuota(), loadDriveInsights()]);

    if (state.activeTab === 'drive') await loadDriveFiles(false);
    if (state.activeTab === 'gmail') await loadGmailMessages(false);

    if (el.filePreviewModalBackdrop.classList.contains('is-open') && state.preview.file) {
      el.previewReauthBtn.classList.add('hidden');
      el.previewRevErrorDetail.classList.add('hidden');
      el.previewRevStatusText.textContent = '已完成重新授權，請再次點擊上方「路線 A」按鈕執行清理。';
      el.previewRevisionStatusBox.style.borderColor = '#065F46';
      await loadFileRevisions(state.preview.file);
    }
  }

  async function tryRestoreSessionToken() {
    try {
      const savedToken = sessionStorage.getItem(SESSION_KEY_TOKEN);
      const savedExpires = Number(sessionStorage.getItem(SESSION_KEY_EXPIRES) || 0);
      if (!savedToken || Date.now() >= savedExpires) {
        sessionStorage.removeItem(SESSION_KEY_TOKEN);
        sessionStorage.removeItem(SESSION_KEY_EXPIRES);
        return;
      }

      state.accessToken = savedToken;
      state.mode = 'google';
      updateAuthUI();
      await Promise.all([fetchGoogleUserInfo(), loadStorageQuota(), loadDriveInsights()]);
    } catch {
      // 忽略還原失敗
    }
  }

  function setupOAuthBackupListeners() {
    window.addEventListener('message', (event) => {
      if (event.origin !== 'https://accounts.google.com') return;
      try {
        const parsed = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        const params = parsed && parsed.params;
        if (
          params &&
          params.type === 'authResult' &&
          params.authResult &&
          (!params.clientId || params.clientId === state.clientId)
        ) {
          handleOAuthTokenResponse(params.authResult);
        }
      } catch {
        // 略過非 JSON 訊息
      }
    });
  }

  function checkUrlHashToken() {
    if (!window.location.hash || !window.location.hash.includes('access_token=')) return;
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = hashParams.get('access_token');
    if (accessToken) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      handleOAuthTokenResponse({
        access_token: accessToken,
        scope: hashParams.get('scope') || OAUTH_SCOPES
      });
    }
  }

  function activateDemoMode() {
    createDemoDataset();
    state.mode = 'demo';
    state.accessToken = null;
    state.user = {
      name: '林家豪（展示測試帳號）',
      email: 'demo.workspace@example.tw',
      picture: ''
    };
    state.drive.items = [];
    state.drive.selectedIds.clear();
    state.gmail.items = [];
    state.gmail.selectedIds.clear();

    updateAuthUI();
    loadStorageQuota();
    loadDriveInsights();
    showToast('已切換至模擬展示模式，您可以自由測試 12/24 預留 20% 空間建議、大資料層排行與批次清理操作。', 'info');
  }

  function signOut() {
    if (state.accessToken && window.google && window.google.accounts && window.google.accounts.oauth2) {
      window.google.accounts.oauth2.revoke(state.accessToken, () => {});
    }
    state.mode = 'guest';
    state.accessToken = null;
    try {
      sessionStorage.removeItem(SESSION_KEY_TOKEN);
      sessionStorage.removeItem(SESSION_KEY_EXPIRES);
    } catch {
      // 忽略 sessionStorage 限制
    }
    state.user = null;
    state.quota = null;
    state.insights.topFiles = [];
    state.insights.folderStats = [];
    state.insights.recommendedFiles = [];
    state.drive.items = [];
    state.drive.selectedIds.clear();
    state.gmail.items = [];
    state.gmail.selectedIds.clear();

    updateAuthUI();
    renderQuotaDashboard();
    renderInsightsDashboard();
    renderDriveTable();
    renderGmailTable();
    showToast('已安全登出並清除本次連線權杖。', 'info');
  }

  function updateAuthUI() {
    if (state.mode === 'google') {
      el.navStatusDot.className = 'w-2 h-2 rounded-full bg-[#10B981]';
      el.navStatusText.textContent = state.user ? state.user.email : '已連線 Google';
      el.navAuthActionBtn.innerHTML = '<i class="ph ph-arrows-clockwise text-base" aria-hidden="true"></i><span>重新授權</span>';
      el.accountModeBadge.textContent = 'Google 即時連線';
      el.accountModeBadge.className = 'px-2 py-1 rounded-md bg-[#064E3B] border border-[#065F46] text-xs font-mono text-[#6EE7B7]';
      el.signedInActionRow.classList.remove('hidden');
    } else if (state.mode === 'demo') {
      el.navStatusDot.className = 'w-2 h-2 rounded-full bg-[#F59E0B]';
      el.navStatusText.textContent = '模擬展示模式';
      el.navAuthActionBtn.innerHTML = '<i class="ph ph-google-logo text-base" aria-hidden="true"></i><span>改用真實帳號</span>';
      el.accountModeBadge.textContent = '模擬展示資料';
      el.accountModeBadge.className = 'px-2 py-1 rounded-md bg-[#451A03] border border-[#78350F] text-xs font-mono text-[#FCD34D]';
      el.signedInActionRow.classList.remove('hidden');
    } else {
      el.navStatusDot.className = 'w-2 h-2 rounded-full bg-[#737373]';
      el.navStatusText.textContent = '尚未連線帳號';
      el.navAuthActionBtn.innerHTML = '<i class="ph ph-sign-in text-base" aria-hidden="true"></i><span>登入 Google</span>';
      el.accountModeBadge.textContent = '未登入';
      el.accountModeBadge.className = 'px-2 py-1 rounded-md bg-[#272727] border border-[#313131] text-xs font-mono text-[#A3A3A3]';
      el.signedInActionRow.classList.add('hidden');
    }

    if (state.user) {
      el.userDisplayName.textContent = state.user.name || 'Google 使用者';
      el.userEmailText.textContent = state.user.email || '';
      if (state.user.picture) {
        el.userAvatarImg.src = state.user.picture;
        el.userAvatarImg.classList.remove('hidden');
        el.userAvatarPlaceholder.classList.add('hidden');
      } else {
        el.userAvatarImg.classList.add('hidden');
        el.userAvatarPlaceholder.classList.remove('hidden');
      }
    } else {
      el.userDisplayName.textContent = '訪客使用者';
      el.userEmailText.textContent = '請登入帳號或啟動模擬模式';
      el.userAvatarImg.classList.add('hidden');
      el.userAvatarPlaceholder.classList.remove('hidden');
    }
  }

  /* ========================================================================
     Google API 統一請求封裝
     ======================================================================== */
  async function googleApiFetch(url, options = {}) {
    if (!state.accessToken) {
      throw new Error('尚未登入或 Access Token 遺失。');
    }
    const headers = Object.assign(
      { Authorization: `Bearer ${state.accessToken}` },
      options.headers || {}
    );
    const response = await fetch(url, Object.assign({}, options, { headers }));

    if (response.status === 401) {
      state.accessToken = null;
      state.mode = 'guest';
      try {
        sessionStorage.removeItem(SESSION_KEY_TOKEN);
        sessionStorage.removeItem(SESSION_KEY_EXPIRES);
      } catch {
        // 忽略 sessionStorage 限制
      }
      updateAuthUI();
      showToast('Google 登入授權已過期，請重新點擊「登入 Google」以續期操作權限。', 'warning');
      throw new Error('授權已過期（HTTP 401）');
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const apiMsg = data?.error?.message || `HTTP ${response.status}`;
      throw new Error(apiMsg);
    }

    return data;
  }

  async function fetchGoogleUserInfo() {
    try {
      const info = await googleApiFetch('https://www.googleapis.com/oauth2/v3/userinfo');
      state.user = {
        name: info.name || info.email,
        email: info.email,
        picture: info.picture || ''
      };
      updateAuthUI();
    } catch (err) {
      console.warn('無法取得使用者基本資料', err);
    }
  }

  /* ========================================================================
     使用量分析模組（Storage Quota）
     ======================================================================== */
  function computeDemoQuota() {
    const activeDrive = state.demoStore.driveFiles
      .filter((f) => !f.trashed)
      .reduce((acc, f) => acc + f.quotaBytesUsed, 0);
    const trashedDrive = state.demoStore.driveFiles
      .filter((f) => f.trashed)
      .reduce((acc, f) => acc + f.quotaBytesUsed, 0);
    const gmailUsed = state.demoStore.gmailMessages.reduce((acc, m) => acc + m.sizeEstimate, 0);
    const totalUsed = activeDrive + trashedDrive + gmailUsed + state.demoStore.otherPhotosBytes;

    return {
      limit: state.demoStore.quotaLimit,
      usage: totalUsed,
      usageInDrive: activeDrive + trashedDrive,
      usageInDriveTrash: trashedDrive,
      source: '模擬展示帳號'
    };
  }

  async function loadStorageQuota() {
    if (state.mode === 'demo') {
      state.quota = computeDemoQuota();
      renderQuotaDashboard();
      return;
    }
    if (state.mode !== 'google') return;

    try {
      const data = await googleApiFetch(`${DRIVE_API_BASE}/about?fields=user,storageQuota`);
      const q = data.storageQuota || {};
      state.quota = {
        limit: Number(q.limit || 0),
        usage: Number(q.usage || 0),
        usageInDrive: Number(q.usageInDrive || 0),
        usageInDriveTrash: Number(q.usageInDriveTrash || 0),
        source: 'Google Drive API v3'
      };
      renderQuotaDashboard();
    } catch (err) {
      showToast(`讀取帳號容量失敗：${err.message}`, 'error');
    }
  }

  function renderQuotaDashboard() {
    if (!state.quota) {
      el.quotaSourceLabel.textContent = '等待載入';
      el.quotaUsedBig.textContent = '0 GB';
      el.quotaLimitBig.textContent = '15 GB';
      el.quotaPercentLabel.textContent = '0.0%';
      el.barDriveSegment.style.width = '0%';
      el.barTrashSegment.style.width = '0%';
      el.barGmailSegment.style.width = '0%';
      el.statDriveUsage.textContent = '—';
      el.statDriveTrash.textContent = '—';
      el.statGmailOther.textContent = '—';
      el.statFreeSpace.textContent = '—';
      renderTarget1224Calculator();
      renderLiveStorageVisualizer();
      return;
    }

    const { limit, usage, usageInDrive, usageInDriveTrash, source } = state.quota;
    const activeDrive = Math.max(0, usageInDrive - usageInDriveTrash);
    const gmailAndOther = Math.max(0, usage - usageInDrive);

    el.quotaSourceLabel.textContent = source;
    el.quotaUsedBig.textContent = formatBytes(usage);
    el.quotaLimitBig.textContent = limit > 0 ? formatBytes(limit) : '無上限配額';

    if (limit > 0) {
      const pct = Math.min(100, (usage / limit) * 100);
      el.quotaPercentLabel.textContent = `${pct.toFixed(1)}%`;
      el.barDriveSegment.style.width = `${Math.min(100, (activeDrive / limit) * 100).toFixed(2)}%`;
      el.barTrashSegment.style.width = `${Math.min(100, (usageInDriveTrash / limit) * 100).toFixed(2)}%`;
      el.barGmailSegment.style.width = `${Math.min(100, (gmailAndOther / limit) * 100).toFixed(2)}%`;
      el.statFreeSpace.textContent = formatBytes(Math.max(0, limit - usage));
    } else {
      const denom = Math.max(usage, 1);
      el.quotaPercentLabel.textContent = '已用統計';
      el.barDriveSegment.style.width = `${((activeDrive / denom) * 100).toFixed(2)}%`;
      el.barTrashSegment.style.width = `${((usageInDriveTrash / denom) * 100).toFixed(2)}%`;
      el.barGmailSegment.style.width = `${((gmailAndOther / denom) * 100).toFixed(2)}%`;
      el.statFreeSpace.textContent = '不限容量';
    }

    el.statDriveUsage.textContent = formatBytes(activeDrive);
    el.statDriveTrash.textContent = formatBytes(usageInDriveTrash);
    el.statGmailOther.textContent = formatBytes(gmailAndOther);

    renderTarget1224Calculator();
    renderLiveStorageVisualizer();
  }

  /* ========================================================================
     12/24 一般使用者 20% 預留空間計算與大資料層 / 長期未使用推薦引擎
     ======================================================================== */
  function getTargetPlanConfig() {
    const mode = el.targetPlanSelect.value;
    let targetLimitBytes = 15 * 1024 * 1024 * 1024;
    if (mode === 'current') {
      targetLimitBytes = state.quota && state.quota.limit > 0
        ? state.quota.limit
        : 15 * 1024 * 1024 * 1024;
    } else if (mode === '100') {
      targetLimitBytes = 100 * 1024 * 1024 * 1024;
    } else if (mode === 'custom') {
      const gb = Math.max(1, Number(el.customTargetGbInput.value) || 15);
      targetLimitBytes = gb * 1024 * 1024 * 1024;
    }

    const reservePercent = Math.min(80, Math.max(5, Number(el.reservePercentSelect.value) || 20));
    const reserveBytes = targetLimitBytes * (reservePercent / 100);
    const safeCapBytes = targetLimitBytes - reserveBytes;
    return { targetLimitBytes, reservePercent, reserveBytes, safeCapBytes };
  }

  function renderTarget1224Calculator() {
    const now = new Date();
    let targetDate = new Date(now.getFullYear(), 11, 24);
    if (now > targetDate) {
      targetDate = new Date(now.getFullYear() + 1, 11, 24);
    }
    const daysLeft = Math.max(0, Math.ceil((targetDate.getTime() - now.getTime()) / 86400000));

    const { targetLimitBytes, reservePercent, reserveBytes, safeCapBytes } = getTargetPlanConfig();
    el.countdown1224Label.textContent = `距離 12/24 方案調整剩 ${daysLeft} 天 · 目標保留至少 ${reservePercent}% 可用空間`;
    el.targetSafeCapDisplay.textContent = formatBytes(safeCapBytes);
    el.targetReserveBytesText.textContent = formatBytes(reserveBytes);

    if (!state.quota) {
      el.targetCurrentRatioText.textContent = '—';
      el.targetCurrentRatioSub.textContent = '請先登入帳號或啟動模擬展示模式';
      el.targetDeficitText.textContent = '—';
      el.targetDeficitText.className = 'text-2xl font-bold font-mono-num text-[#F59E0B]';
      el.targetDeficitSub.textContent = '系統將優先列出最舊且佔空間的項目';
      return;
    }

    const currentUsage = state.quota.usage || 0;
    const usedPct = targetLimitBytes > 0 ? (currentUsage / targetLimitBytes) * 100 : 0;
    const freePct = Math.max(0, 100 - usedPct);
    const deficitBytes = Math.max(0, currentUsage - safeCapBytes);

    el.targetCurrentRatioText.textContent = `${formatBytes(currentUsage)}（佔 ${usedPct.toFixed(1)}%）`;
    el.targetCurrentRatioSub.textContent = currentUsage >= targetLimitBytes
      ? `已超出目標總配額 ${formatBytes(currentUsage - targetLimitBytes)}`
      : `目標總配額 ${formatBytes(targetLimitBytes)}，目前僅餘 ${freePct.toFixed(1)}% 可用`;

    if (deficitBytes > 0) {
      el.targetDeficitText.textContent = `需刪除 ${formatBytes(deficitBytes)}`;
      el.targetDeficitText.className = 'text-2xl font-bold font-mono-num text-[#FCA5A5]';
      el.targetDeficitSub.textContent = `達成後總使用量將降至 ${formatBytes(safeCapBytes)} 以下，完整保留 ${reservePercent}% 緩衝`;
    } else {
      const extraBuffer = safeCapBytes - currentUsage;
      el.targetDeficitText.textContent = '已達標（0 B 缺口）';
      el.targetDeficitText.className = 'text-2xl font-bold font-mono-num text-[#10B981]';
      el.targetDeficitSub.textContent = `目前比 ${reservePercent}% 安全上限還寬裕 ${formatBytes(extraBuffer)}`;
    }
  }

  function getLiveTargetConfig() {
    const mode = el.liveTargetModeSelect ? el.liveTargetModeSelect.value : '15';
    let targetLimitBytes = 15 * 1024 * 1024 * 1024;
    if (mode === 'current') {
      targetLimitBytes = state.quota && state.quota.limit > 0
        ? state.quota.limit
        : 15 * 1024 * 1024 * 1024;
    } else if (mode === '100') {
      targetLimitBytes = 100 * 1024 * 1024 * 1024;
    }

    const reservePercent = Math.min(50, Math.max(5, Number(el.liveReserveSlider?.value) || 20));
    const safeCapPct = 100 - reservePercent;
    const reserveBytes = targetLimitBytes * (reservePercent / 100);
    const safeCapBytes = targetLimitBytes - reserveBytes;
    return { targetLimitBytes, reservePercent, safeCapPct, reserveBytes, safeCapBytes };
  }

  function renderLiveStorageVisualizer() {
    if (!el.liveStorageVisualizer) return;

    const { targetLimitBytes, reservePercent, safeCapPct, safeCapBytes } = getLiveTargetConfig();
    const outerCirc = 2 * Math.PI * 66;
    const innerCirc = 2 * Math.PI * 50;

    el.liveReservePctLabel.textContent = `保留 ${reservePercent}%`;
    el.liveTargetCapVal.textContent = formatBytes(safeCapBytes);
    el.liveRulerCaption.textContent = `總目標配額 ${formatBytes(targetLimitBytes)} · 須預留 ${reservePercent}%`;
    el.liveTargetLineLabel.textContent = `目標上限 ${safeCapPct}%`;
    el.liveTargetLineLabel.style.left = `${safeCapPct}%`;
    el.liveTargetLine.style.left = `${safeCapPct}%`;
    el.liveProjectedTargetLine.style.left = `${safeCapPct}%`;
    el.liveReserveZone.style.width = `${reservePercent}%`;
    el.gaugeCenterSub.textContent = `目標上限 ${safeCapPct}%`;

    // 計算目標刻度線座標（隨 reserveSlider 即時旋轉）
    const theta = 2 * Math.PI * (safeCapPct / 100);
    const x1 = (80 + 55 * Math.cos(theta)).toFixed(2);
    const y1 = (80 + 55 * Math.sin(theta)).toFixed(2);
    const x2 = (80 + 75 * Math.cos(theta)).toFixed(2);
    const y2 = (80 + 75 * Math.sin(theta)).toFixed(2);
    el.svgTargetMarker.setAttribute('x1', x1);
    el.svgTargetMarker.setAttribute('y1', y1);
    el.svgTargetMarker.setAttribute('x2', x2);
    el.svgTargetMarker.setAttribute('y2', y2);

    if (!state.quota) {
      el.svgOuterArc.style.strokeDashoffset = outerCirc.toFixed(2);
      el.svgInnerArc.style.strokeDashoffset = innerCirc.toFixed(2);
      el.gaugeCenterPct.textContent = '0.0%';
      el.liveBarDrive.style.width = '0%';
      el.liveBarTrash.style.width = '0%';
      el.liveBarGmail.style.width = '0%';
      el.liveProjectedBar.style.transform = 'scaleX(0)';
      el.liveCurrentUsageVal.textContent = '—';
      el.liveGapDiffVal.textContent = '—';
      el.liveSelectedReleaseVal.textContent = '0 B';
      el.liveProjectedText.textContent = '尚未載入空間資料';
      el.liveGapStatusPill.textContent = '等待載入帳號空間';
      el.liveGapStatusPill.className = 'px-3 py-1 rounded-lg text-xs font-semibold diff-pill-neutral';
      return;
    }

    const currentUsage = state.quota.usage || 0;
    const driveInUse = Math.max(0, (state.quota.usageInDrive || 0) - (state.quota.usageInDriveTrash || 0));
    const driveTrash = Math.max(0, state.quota.usageInDriveTrash || 0);
    const gmailOther = Math.max(0, currentUsage - (state.quota.usageInDrive || 0));

    const selectedDriveBytes = state.drive.items
      .filter((item) => state.drive.selectedIds.has(item.id))
      .reduce((sum, item) => sum + (Number(item.quotaBytesUsed) || 0), 0);
    const selectedGmailBytes = state.gmail.items
      .filter((m) => state.gmail.selectedIds.has(m.id))
      .reduce((sum, m) => sum + (Number(m.sizeEstimate) || 0), 0);
    const selectedReleaseBytes = selectedDriveBytes + selectedGmailBytes;
    const projectedUsage = Math.max(0, currentUsage - selectedReleaseBytes);

    const usedPct = targetLimitBytes > 0 ? (currentUsage / targetLimitBytes) * 100 : 0;
    const projectedPct = targetLimitBytes > 0 ? (projectedUsage / targetLimitBytes) * 100 : 0;
    const gapBytes = currentUsage - safeCapBytes;
    const projectedGapBytes = projectedUsage - safeCapBytes;

    // 外環：目前實際用量
    const outerProgress = Math.min(1, usedPct / 100);
    el.svgOuterArc.style.strokeDashoffset = (outerCirc * (1 - outerProgress)).toFixed(2);
    el.svgOuterArc.setAttribute('stroke', gapBytes > 0 ? '#EF4444' : '#3B82F6');

    // 內環：扣除已勾選待刪項目後的預計用量
    const innerProgress = Math.min(1, projectedPct / 100);
    el.svgInnerArc.style.strokeDashoffset = (innerCirc * (1 - innerProgress)).toFixed(2);

    el.gaugeCenterPct.textContent = `${usedPct.toFixed(1)}%`;

    // 尺規一：三色進度分段
    const barScaleDenom = Math.max(targetLimitBytes, currentUsage, 1);
    const totalFillRatio = Math.min(1, currentUsage / targetLimitBytes);
    const drivePct = currentUsage > 0 ? (driveInUse / barScaleDenom) * 100 * (currentUsage > targetLimitBytes ? 1 : (barScaleDenom / targetLimitBytes)) : 0;
    const trashPct = currentUsage > 0 ? (driveTrash / barScaleDenom) * 100 * (currentUsage > targetLimitBytes ? 1 : (barScaleDenom / targetLimitBytes)) : 0;
    const gmailPct = currentUsage > 0 ? (gmailOther / barScaleDenom) * 100 * (currentUsage > targetLimitBytes ? 1 : (barScaleDenom / targetLimitBytes)) : 0;

    if (currentUsage <= targetLimitBytes) {
      el.liveBarDrive.style.width = `${((driveInUse / targetLimitBytes) * 100).toFixed(2)}%`;
      el.liveBarTrash.style.width = `${((driveTrash / targetLimitBytes) * 100).toFixed(2)}%`;
      el.liveBarGmail.style.width = `${((gmailOther / targetLimitBytes) * 100).toFixed(2)}%`;
    } else {
      el.liveBarDrive.style.width = `${(drivePct * totalFillRatio).toFixed(2)}%`;
      el.liveBarTrash.style.width = `${(trashPct * totalFillRatio).toFixed(2)}%`;
      el.liveBarGmail.style.width = `${(gmailPct * totalFillRatio).toFixed(2)}%`;
    }

    // 尺規二：勾選清理後模擬水位
    el.liveProjectedBar.style.transform = `scaleX(${Math.min(1, projectedPct / 100).toFixed(4)})`;
    el.liveProjectedBar.style.backgroundColor = projectedGapBytes > 0 ? '#F59E0B' : '#10B981';

    el.liveCurrentUsageVal.textContent = formatBytes(currentUsage);
    el.liveSelectedReleaseVal.textContent = formatBytes(selectedReleaseBytes);

    if (gapBytes > 0) {
      el.liveGapDiffVal.textContent = `超標 ${formatBytes(gapBytes)}`;
      el.liveGapDiffVal.className = 'text-base font-bold font-mono-num text-[#FCA5A5]';
      el.liveGapStatusPill.textContent = `超標 · 須釋放 ${formatBytes(gapBytes)}`;
      el.liveGapStatusPill.className = 'px-3 py-1 rounded-lg text-xs font-semibold diff-pill-danger';
    } else {
      el.liveGapDiffVal.textContent = `餘裕 ${formatBytes(Math.abs(gapBytes))}`;
      el.liveGapDiffVal.className = 'text-base font-bold font-mono-num text-[#10B981]';
      el.liveGapStatusPill.textContent = `已達目標 · 預留充足`;
      el.liveGapStatusPill.className = 'px-3 py-1 rounded-lg text-xs font-semibold diff-pill-safe';
    }

    if (selectedReleaseBytes > 0) {
      el.liveProjectedText.textContent = projectedGapBytes > 0
        ? `預計降至 ${formatBytes(projectedUsage)}（${projectedPct.toFixed(1)}% · 仍差 ${formatBytes(projectedGapBytes)}）`
        : `預計降至 ${formatBytes(projectedUsage)}（${projectedPct.toFixed(1)}% · 刪除後即可達標）`;
      el.liveProjectedText.className = projectedGapBytes > 0
        ? 'font-mono-num text-[#FCD34D]'
        : 'font-mono-num text-[#10B981]';
    } else {
      el.liveProjectedText.textContent = `尚未勾選待刪項目（目前佔比 ${usedPct.toFixed(1)}%）`;
      el.liveProjectedText.className = 'font-mono-num text-[#A3A3A3]';
    }
  }

  function getUnusedDaysForFile(file) {
    const lastActive = file.viewedByMeTime || file.modifiedTime;
    return calcDaysAgo(lastActive);
  }

  async function resolveFolderNames(folderIds) {
    const missing = folderIds.filter((id) => id && !state.folderNameMap[id]);
    if (missing.length === 0 || state.mode !== 'google') return;

    await runWithConcurrency(missing.slice(0, 30), 6, async (folderId) => {
      try {
        const meta = await googleApiFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}?fields=id,name`);
        state.folderNameMap[folderId] = meta?.name || '未命名資料夾';
      } catch {
        state.folderNameMap[folderId] = '未命名資料層（共用或無權限）';
      }
    });
  }

  function buildInsightsFromFiles(rawFiles) {
    const activeFiles = rawFiles.filter((f) => !f.trashed);
    const folderMap = new Map();

    const enriched = activeFiles.map((file) => {
      const parentId = Array.isArray(file.parents) && file.parents.length > 0 ? file.parents[0] : 'root';
      const folderName = state.folderNameMap[parentId] || '我的雲端硬碟根目錄';
      const unusedDays = getUnusedDaysForFile(file);
      const sizeBytes = Number(file.quotaBytesUsed || file.size || 0);
      const priorityScore = (sizeBytes / 1048576) * Math.max(30, unusedDays);

      return Object.assign({}, file, {
        folderId: parentId,
        folderName,
        unusedDays,
        priorityScore
      });
    });

    enriched.forEach((file) => {
      if (!folderMap.has(file.folderId)) {
        folderMap.set(file.folderId, {
          id: file.folderId,
          name: file.folderName,
          totalBytes: 0,
          fileCount: 0,
          maxUnusedDays: 0,
          files: []
        });
      }
      const entry = folderMap.get(file.folderId);
      entry.totalBytes += Number(file.quotaBytesUsed || 0);
      entry.fileCount += 1;
      entry.maxUnusedDays = Math.max(entry.maxUnusedDays, file.unusedDays);
      entry.files.push(file);
    });

    const folderStats = Array.from(folderMap.values()).sort((a, b) => b.totalBytes - a.totalBytes);
    const recommendedFiles = enriched
      .slice()
      .sort((a, b) => b.priorityScore - a.priorityScore);

    state.insights.topFiles = enriched;
    state.insights.folderStats = folderStats;
    state.insights.recommendedFiles = recommendedFiles;
  }

  async function loadDriveInsights() {
    if (state.mode === 'guest') {
      renderInsightsDashboard();
      return;
    }

    state.insights.loading = true;
    renderInsightsLoading();

    try {
      if (state.mode === 'demo') {
        await new Promise((r) => setTimeout(r, 180));
        buildInsightsFromFiles(state.demoStore.driveFiles);
      } else {
        const queryUrl = new URL(`${DRIVE_API_BASE}/files`);
        queryUrl.searchParams.set('q', "trashed = false and 'me' in owners and mimeType != 'application/vnd.google-apps.folder'");
        queryUrl.searchParams.set('pageSize', '100');
        queryUrl.searchParams.set('orderBy', 'quotaBytesUsed desc');
        queryUrl.searchParams.set('fields', 'files(id,name,mimeType,size,quotaBytesUsed,modifiedTime,viewedByMeTime,parents,trashed)');

        const data = await googleApiFetch(queryUrl.toString());
        const rawFiles = (data.files || []).map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: Number(f.size || 0),
          quotaBytesUsed: Number(f.quotaBytesUsed || f.size || 0),
          modifiedTime: f.modifiedTime,
          viewedByMeTime: f.viewedByMeTime || f.modifiedTime,
          parents: Array.isArray(f.parents) ? f.parents : ['root'],
          trashed: Boolean(f.trashed)
        }));

        const parentIds = Array.from(new Set(rawFiles.flatMap((f) => f.parents || [])));
        await resolveFolderNames(parentIds);
        buildInsightsFromFiles(rawFiles);
      }
    } catch (err) {
      showToast(`掃描大資料層與未使用檔案時發生錯誤：${err.message}`, 'error');
    } finally {
      state.insights.loading = false;
      populateDriveFolderFilter();
      renderInsightsDashboard();
    }
  }

  function populateDriveFolderFilter() {
    if (!el.driveFolderFilter) return;
    const prevValue = el.driveFolderFilter.value || 'all';
    const options = ['<option value="all">全部資料層（不限資料夾）</option>'];
    state.insights.folderStats.forEach((folder) => {
      options.push(
        `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}（${formatBytes(folder.totalBytes)} · ${folder.fileCount} 個大檔）</option>`
      );
    });
    el.driveFolderFilter.innerHTML = options.join('');
    if (Array.from(el.driveFolderFilter.options).some((opt) => opt.value === prevValue)) {
      el.driveFolderFilter.value = prevValue;
    }
  }

  function renderInsightsLoading() {
    el.folderRankingList.innerHTML = Array.from({ length: 3 }, () => '<div class="skeleton-box h-16 w-full"></div>').join('');
    el.unusedLargeFilesList.innerHTML = Array.from({ length: 3 }, () => '<div class="skeleton-box h-16 w-full"></div>').join('');
  }

  function renderInsightsDashboard() {
    if (state.mode === 'guest') {
      el.planASizeBadge.textContent = '—';
      el.planBSizeBadge.textContent = '—';
      el.planCSizeBadge.textContent = '—';
      el.folderRankingList.innerHTML = '<div class="surface-card-inner text-sm text-[#A3A3A3] py-6 text-center">登入 Google 帳號或進入模擬展示模式後，將自動彙總您的雲端硬碟大資料層排行。</div>';
      el.unusedLargeFilesList.innerHTML = '<div class="surface-card-inner text-sm text-[#A3A3A3] py-6 text-center">登入 Google 帳號或進入模擬展示模式後，將自動分析您最久未開啟的大型檔案。</div>';
      renderTarget1224Calculator();
      return;
    }

    const trashBytes = state.quota ? state.quota.usageInDriveTrash : 0;
    const planADriveBytes = state.insights.recommendedFiles
      .filter((f) => f.unusedDays >= 365 && f.quotaBytesUsed >= 100 * 1048576)
      .reduce((sum, f) => sum + f.quotaBytesUsed, 0);
    const planABytes = trashBytes + planADriveBytes;

    const planBDriveBytes = state.insights.recommendedFiles
      .filter((f) => f.unusedDays >= 180 && f.quotaBytesUsed >= 50 * 1048576)
      .reduce((sum, f) => sum + f.quotaBytesUsed, 0);
    const demoGmailBytes = state.mode === 'demo'
      ? state.demoStore.gmailMessages
        .filter((m) => !m.inTrash && m.sizeEstimate >= 5 * 1048576 && calcDaysAgo(m.internalDate) >= 180)
        .reduce((sum, m) => sum + m.sizeEstimate, 0)
      : 0;
    const planBBytes = planBDriveBytes + demoGmailBytes;

    const planCBytes = state.insights.folderStats
      .slice(0, 3)
      .reduce((sum, fld) => sum + fld.totalBytes, 0);

    el.planASizeBadge.textContent = `可釋放 ${formatBytes(planABytes)}`;
    el.planBSizeBadge.textContent = state.mode === 'google'
      ? `Drive ${formatBytes(planBDriveBytes)} ＋ Gmail`
      : `可釋放 ${formatBytes(planBBytes)}`;
    el.planCSizeBadge.textContent = `前三大共 ${formatBytes(planCBytes)}`;

    // 渲染左欄：大資料層排行
    if (state.insights.folderStats.length === 0) {
      el.folderRankingList.innerHTML = '<div class="surface-card-inner text-sm text-[#A3A3A3] py-6 text-center">目前無大型檔案資料層可供排行。</div>';
    } else {
      const topTotal = Math.max(state.insights.folderStats[0].totalBytes, 1);
      el.folderRankingList.innerHTML = state.insights.folderStats.slice(0, 5).map((folder, index) => {
        const barPct = Math.max(8, Math.round((folder.totalBytes / topTotal) * 100));
        return `
          <div class="surface-card-inner space-y-2">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-semibold text-white truncate">
                  <span class="font-mono-num text-[#A3A3A3] mr-1">#${index + 1}</span>
                  ${escapeHtml(folder.name)}
                </p>
                <p class="text-xs text-[#737373]">${folder.fileCount} 個大型檔案 · 最久已閒置 ${folder.maxUnusedDays} 天</p>
              </div>
              <span class="text-sm font-bold font-mono-num text-white shrink-0">${formatBytes(folder.totalBytes)}</span>
            </div>
            <div class="w-full h-1.5 rounded-full bg-[#181818] overflow-hidden">
              <div class="h-full bg-[#3B82F6] rounded-full" style="width: ${barPct}%"></div>
            </div>
            <div class="flex items-center justify-end gap-2 pt-1">
              <button type="button" class="btn-secondary text-xs insight-folder-view-btn" data-folder-id="${escapeHtml(folder.id)}">只看此資料層檔案</button>
              <button type="button" class="btn-danger text-xs insight-folder-trash-btn" data-folder-id="${escapeHtml(folder.id)}">整層移至垃圾桶</button>
            </div>
          </div>
        `;
      }).join('');
    }

    // 渲染右欄：長期未使用大檔案推薦
    if (state.insights.recommendedFiles.length === 0) {
      el.unusedLargeFilesList.innerHTML = '<div class="surface-card-inner text-sm text-[#A3A3A3] py-6 text-center">目前無長期未使用的大型檔案。</div>';
    } else {
      el.unusedLargeFilesList.innerHTML = state.insights.recommendedFiles.slice(0, 5).map((file) => {
        const badgeColor = file.unusedDays >= 365
          ? 'bg-[#3B1212] border-[#7F1D1D] text-[#FCA5A5]'
          : 'bg-[#451A03] border-[#78350F] text-[#FCD34D]';
        return `
          <div class="surface-card-inner space-y-2">
            <div class="flex items-start justify-between gap-3">
              <div class="flex items-start gap-2 min-w-0">
                <i class="ph ${getFileIconClass(file.mimeType)} text-lg text-white mt-0.5 shrink-0" aria-hidden="true"></i>
                <div class="min-w-0">
                  <p class="text-sm font-semibold text-white truncate" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</p>
                  <p class="text-xs text-[#737373] truncate">資料層：${escapeHtml(file.folderName)}</p>
                </div>
              </div>
              <span class="text-sm font-bold font-mono-num text-white shrink-0">${formatBytes(file.quotaBytesUsed)}</span>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
              <span class="px-2 py-0.5 rounded-md border text-xs font-mono-num ${badgeColor}">已 ${file.unusedDays} 天未開啟</span>
              <div class="flex items-center gap-2">
                <button type="button" class="btn-secondary text-xs insight-file-trash-btn" data-file-id="${escapeHtml(file.id)}">移至垃圾桶</button>
                <button type="button" class="btn-danger text-xs insight-file-delete-btn" data-file-id="${escapeHtml(file.id)}">永久刪除</button>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    renderTarget1224Calculator();
    renderLiveStorageVisualizer();
  }

  async function autoSelectToMeetTarget() {
    if (state.mode === 'guest') {
      activateDemoMode();
      await new Promise((r) => setTimeout(r, 250));
    }

    const { safeCapBytes, reservePercent } = getTargetPlanConfig();
    const currentUsage = state.quota ? state.quota.usage : 0;
    const deficit = Math.max(0, currentUsage - safeCapBytes);

    if (deficit <= 0) {
      showToast(`目前空間已低於保留 ${reservePercent}% 的安全上限，無須強制刪除。`, 'success');
      return;
    }

    const candidates = state.insights.recommendedFiles;
    if (!candidates || candidates.length === 0) {
      showToast('目前尚未掃描到可挑選的雲端硬碟大檔案，請先點擊「重新掃描大資料層」。', 'warning');
      return;
    }

    const pickedIds = [];
    let accumulated = 0;
    const trashBytes = state.quota ? state.quota.usageInDriveTrash : 0;
    let effectiveNeed = Math.max(0, deficit - trashBytes);

    if (effectiveNeed <= 0 && trashBytes > 0) {
      el.driveSizeFilter.value = '0';
      el.driveDaysFilter.value = '0';
      el.driveScopeFilter.value = 'trash';
      el.driveFolderFilter.value = 'all';
      switchTab('drive');
      await loadDriveFiles(false);
      showToast(`您光靠「一鍵清空雲端硬碟垃圾桶」（${formatBytes(trashBytes)}）就能達成保留 ${reservePercent}% 的目標。`, 'info');
      return;
    }

    for (const file of candidates) {
      pickedIds.push(file.id);
      accumulated += Number(file.quotaBytesUsed || 0);
      if (accumulated >= deficit) break;
    }

    el.driveSizeFilter.value = '0';
    el.driveDaysFilter.value = '0';
    el.driveScopeFilter.value = 'active';
    el.driveFolderFilter.value = 'all';
    el.driveTypeFilter.value = 'all';
    el.driveSortSelect.value = 'recommend desc';
    el.driveSearchInput.value = '';
    el.driveCustomSizeWrap.classList.add('hidden');
    el.driveCustomDaysWrap.classList.add('hidden');

    state.drive.items = candidates.slice();
    state.drive.selectedIds = new Set(pickedIds);
    state.drive.nextPageToken = null;
    switchTab('drive');
    renderDriveTable();

    showToast(
      `已為您自動勾選 ${pickedIds.length} 個最長期未用的大檔案（合計 ${formatBytes(accumulated)}），刪除並清空垃圾桶後即可達成保留 ${reservePercent}% 空間目標。`,
      'success'
    );
  }

  /* ========================================================================
     Google 雲端硬碟篩選與清理模組
     ======================================================================== */
  function getDriveFilterParams() {
    const sizeMode = el.driveSizeFilter.value;
    const minMB = sizeMode === 'custom'
      ? Math.max(0, Number(el.driveCustomSizeInput.value) || 0)
      : Number(sizeMode) || 0;

    const daysMode = el.driveDaysFilter.value;
    const minDays = daysMode === 'custom'
      ? Math.max(0, Number(el.driveCustomDaysInput.value) || 0)
      : Number(daysMode) || 0;

    return {
      minBytes: minMB * 1048576,
      minDays,
      type: el.driveTypeFilter.value,
      scope: el.driveScopeFilter.value,
      folderId: el.driveFolderFilter ? el.driveFolderFilter.value : 'all',
      sort: el.driveSortSelect.value,
      keyword: el.driveSearchInput.value.trim()
    };
  }

  function buildDriveApiQuery(params) {
    const clauses = [];
    clauses.push(params.scope === 'trash' ? 'trashed = true' : 'trashed = false');
    clauses.push("'me' in owners");

    if (params.folderId && params.folderId !== 'all') {
      const safeFolderId = params.folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      clauses.push(`'${safeFolderId}' in parents`);
    }

    if (params.minBytes > 0) {
      clauses.push(`size > ${Math.floor(params.minBytes)}`);
    }

    if (params.minDays > 0) {
      const cutoffIso = new Date(Date.now() - params.minDays * 86400000).toISOString();
      clauses.push(`modifiedTime < '${cutoffIso}'`);
    }

    if (params.type === 'folder') {
      clauses.push("mimeType = 'application/vnd.google-apps.folder'");
    } else if (params.type === 'video') {
      clauses.push("mimeType contains 'video/'");
    } else if (params.type === 'image') {
      clauses.push("mimeType contains 'image/'");
    } else if (params.type === 'archive') {
      clauses.push("(mimeType contains 'zip' or mimeType contains 'rar' or mimeType contains 'compressed' or mimeType contains '7z')");
    } else if (params.type === 'document') {
      clauses.push("(mimeType = 'application/pdf' or mimeType contains 'word' or mimeType contains 'presentation' or mimeType contains 'spreadsheet')");
    }

    if (params.keyword) {
      const safeKeyword = params.keyword.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      clauses.push(`name contains '${safeKeyword}'`);
    }

    return clauses.join(' and ');
  }

  function renderDriveSkeleton() {
    const rows = Array.from({ length: 5 }, () => `
      <tr>
        <td><div class="skeleton-box w-4 h-4"></div></td>
        <td><div class="skeleton-box h-5 w-64"></div></td>
        <td><div class="skeleton-box h-5 w-20"></div></td>
        <td><div class="skeleton-box h-5 w-24"></div></td>
        <td><div class="skeleton-box h-5 w-16"></div></td>
        <td class="text-right"><div class="skeleton-box h-7 w-24 ml-auto"></div></td>
      </tr>
    `).join('');
    el.driveTableBody.innerHTML = rows;
  }

  function mapDriveApiOrderBy(sortMode) {
    if (sortMode === 'modifiedTime asc') return 'modifiedTime';
    if (sortMode === 'modifiedTime desc') return 'modifiedTime desc';
    if (sortMode === 'name asc') return 'name';
    if (sortMode === 'name desc') return 'name desc';
    if (sortMode === 'quotaBytesUsed asc') return 'quotaBytesUsed';
    return 'quotaBytesUsed desc';
  }

  function sortDriveItemsList(list, sortMode) {
    list.sort((a, b) => {
      if (sortMode === 'recommend desc') {
        const scoreA = (Number(a.quotaBytesUsed || 0) / 1048576) * Math.max(30, getUnusedDaysForFile(a));
        const scoreB = (Number(b.quotaBytesUsed || 0) / 1048576) * Math.max(30, getUnusedDaysForFile(b));
        return scoreB - scoreA;
      }
      if (sortMode === 'quotaBytesUsed desc') return (Number(b.quotaBytesUsed) || 0) - (Number(a.quotaBytesUsed) || 0);
      if (sortMode === 'quotaBytesUsed asc') return (Number(a.quotaBytesUsed) || 0) - (Number(b.quotaBytesUsed) || 0);
      if (sortMode === 'modifiedTime asc') return Date.parse(a.modifiedTime || 0) - Date.parse(b.modifiedTime || 0);
      if (sortMode === 'modifiedTime desc') return Date.parse(b.modifiedTime || 0) - Date.parse(a.modifiedTime || 0);
      if (sortMode === 'unused desc') return getUnusedDaysForFile(b) - getUnusedDaysForFile(a);
      if (sortMode === 'unused asc') return getUnusedDaysForFile(a) - getUnusedDaysForFile(b);
      if (sortMode === 'name asc') return (a.name || '').localeCompare(b.name || '', 'zh-Hant', { numeric: true });
      if (sortMode === 'name desc') return (b.name || '').localeCompare(a.name || '', 'zh-Hant', { numeric: true });
      return 0;
    });
  }

  async function loadDriveFiles(append = false) {
    if (state.mode === 'guest') {
      renderDriveTable();
      return;
    }

    const params = getDriveFilterParams();
    updateFolderNavBar(params.folderId);
    state.drive.loading = true;

    if (!append) {
      state.drive.items = [];
      state.drive.selectedIds.clear();
      state.drive.nextPageToken = null;
      renderDriveSkeleton();
    }

    try {
      if (state.mode === 'demo') {
        await new Promise((r) => setTimeout(r, 240));
        let sourceList = state.demoStore.driveFiles.slice();
        if (params.type === 'folder') {
          sourceList = Object.entries(state.folderNameMap)
            .filter(([id]) => id !== 'root')
            .map(([id, name]) => ({
              id,
              name,
              mimeType: 'application/vnd.google-apps.folder',
              size: 0,
              quotaBytesUsed: 0,
              createdTime: new Date(Date.now() - 400 * 86400000).toISOString(),
              modifiedTime: new Date(Date.now() - 120 * 86400000).toISOString(),
              viewedByMeTime: new Date(Date.now() - 120 * 86400000).toISOString(),
              parents: ['root'],
              trashed: false
            }));
        }

        const filtered = sourceList.filter((file) => {
          if (params.scope === 'trash' && !file.trashed) return false;
          if (params.scope === 'active' && file.trashed) return false;
          if (params.folderId && params.folderId !== 'all') {
            const pid = Array.isArray(file.parents) && file.parents[0] ? file.parents[0] : 'root';
            if (pid !== params.folderId) return false;
          }
          if (params.minBytes > 0 && Number(file.quotaBytesUsed) < params.minBytes) return false;
          if (params.minDays > 0 && getUnusedDaysForFile(file) < params.minDays) return false;

          if (params.type === 'folder' && file.mimeType !== 'application/vnd.google-apps.folder') return false;
          if (params.type === 'video' && !file.mimeType.startsWith('video/')) return false;
          if (params.type === 'image' && !file.mimeType.startsWith('image/')) return false;
          if (params.type === 'archive' && !/(zip|rar|compressed|octet-stream)/i.test(file.mimeType + file.name)) return false;
          if (params.type === 'document' && !file.mimeType.includes('pdf') && !file.mimeType.includes('sheet')) return false;

          if (params.keyword && !file.name.toLowerCase().includes(params.keyword.toLowerCase())) return false;
          return true;
        });

        sortDriveItemsList(filtered, params.sort);
        state.drive.items = filtered;
        state.drive.nextPageToken = null;
      } else {
        const q = buildDriveApiQuery(params);
        const queryUrl = new URL(`${DRIVE_API_BASE}/files`);
        queryUrl.searchParams.set('q', q);
        queryUrl.searchParams.set('pageSize', '50');
        queryUrl.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,quotaBytesUsed,createdTime,modifiedTime,viewedByMeTime,parents,md5Checksum,headRevisionId,thumbnailLink,webContentLink,webViewLink,trashed)');
        const apiOrderBy = mapDriveApiOrderBy(params.sort);
        queryUrl.searchParams.set('orderBy', apiOrderBy);
        if (append && state.drive.nextPageToken) {
          queryUrl.searchParams.set('pageToken', state.drive.nextPageToken);
        }

        const data = await googleApiFetch(queryUrl.toString());
        const fetched = (data.files || []).map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: Number(f.size || 0),
          quotaBytesUsed: Number(f.quotaBytesUsed || f.size || 0),
          createdTime: f.createdTime || f.modifiedTime,
          modifiedTime: f.modifiedTime,
          viewedByMeTime: f.viewedByMeTime || f.modifiedTime,
          parents: Array.isArray(f.parents) ? f.parents : ['root'],
          md5Checksum: f.md5Checksum || '',
          headRevisionId: f.headRevisionId || '',
          thumbnailLink: f.thumbnailLink || '',
          webContentLink: f.webContentLink || '',
          trashed: Boolean(f.trashed),
          webViewLink: f.webViewLink || ''
        }));

        const parentIds = Array.from(new Set(fetched.flatMap((f) => f.parents || [])));
        await resolveFolderNames(parentIds);

        const merged = append ? state.drive.items.concat(fetched) : fetched;
        sortDriveItemsList(merged, params.sort);
        state.drive.items = merged;
        state.drive.nextPageToken = data.nextPageToken || null;
      }
    } catch (err) {
      showToast(`查詢 Google 雲端硬碟失敗：${err.message}`, 'error');
    } finally {
      state.drive.loading = false;
      renderDriveTable();
    }
  }

  function updateDriveSelectionStats() {
    const selectedItems = state.drive.items.filter((item) => state.drive.selectedIds.has(item.id));
    const totalBytes = selectedItems.reduce((sum, item) => sum + (Number(item.quotaBytesUsed) || 0), 0);

    el.driveTotalCount.textContent = String(state.drive.items.length);
    el.driveSelectedCount.textContent = String(selectedItems.length);
    el.driveSelectedSize.textContent = formatBytes(totalBytes);

    const hasSelection = selectedItems.length > 0;
    const isTrashScope = el.driveScopeFilter.value === 'trash';
    el.driveBatchTrashBtn.disabled = !hasSelection || isTrashScope;
    el.driveBatchDeleteBtn.disabled = !hasSelection;

    el.driveSelectAllCheckbox.checked = state.drive.items.length > 0 && selectedItems.length === state.drive.items.length;
    updateSortHeaderUI();
    renderLiveStorageVisualizer();
  }

  function renderDriveTable() {
    if (state.mode === 'guest') {
      el.driveTableBody.innerHTML = `
        <tr>
          <td colspan="6" class="py-12 text-center">
            <div class="space-y-3 max-w-md mx-auto">
              <p class="text-base font-semibold text-white">尚未載入 Google 雲端硬碟資料</p>
              <p class="text-sm text-[#A3A3A3]">請返回「使用量總覽」登入您的 Google 帳號，或啟動模擬展示模式立即試用大小與天數清理工具。</p>
            </div>
          </td>
        </tr>
      `;
      el.drivePaginationWrap.classList.add('hidden');
      updateDriveSelectionStats();
      return;
    }

    if (state.drive.items.length === 0) {
      el.driveTableBody.innerHTML = `
        <tr>
          <td colspan="6" class="py-12 text-center">
            <div class="space-y-2 max-w-md mx-auto">
              <p class="text-base font-semibold text-white">沒有符合目前篩選條件的檔案</p>
              <p class="text-sm text-[#A3A3A3]">請嘗試調降大檔案 MB 門檻、縮短資料天數，或切換「一般檔案」與「垃圾桶」範圍後重新查詢。</p>
            </div>
          </td>
        </tr>
      `;
      el.drivePaginationWrap.classList.add('hidden');
      updateDriveSelectionStats();
      return;
    }

    const isTrashScope = el.driveScopeFilter.value === 'trash';

    el.driveTableBody.innerHTML = state.drive.items.map((item) => {
      const checked = state.drive.selectedIds.has(item.id);
      const isFolder = item.mimeType === 'application/vnd.google-apps.folder';
      const unusedDays = getUnusedDaysForFile(item);
      const parentId = Array.isArray(item.parents) && item.parents.length > 0 ? item.parents[0] : 'root';
      const folderName = state.folderNameMap[parentId] || '我的雲端硬碟根目錄';
      const lastDate = item.viewedByMeTime || item.modifiedTime;
      const ageBadgeClass = unusedDays >= 365
        ? 'bg-[#3B1212] border-[#7F1D1D] text-[#FCA5A5]'
        : unusedDays >= 180
          ? 'bg-[#451A03] border-[#78350F] text-[#FCD34D]'
          : 'bg-[#272727] border-[#313131] text-[#A3A3A3]';

      const revisionDiff = !isFolder && item.size > 0 && item.quotaBytesUsed > item.size * 1.1
        ? item.quotaBytesUsed - item.size
        : 0;

      const dupBadgeHtml = state.duplicates.redundantIds.has(item.id)
        ? '<span class="dup-badge">重複舊副本</span>'
        : state.duplicates.keepIds.has(item.id)
          ? '<span class="keep-badge">最新保留版</span>'
          : '';

      const revBadgeHtml = revisionDiff > 1048576
        ? `<span class="dup-badge">含舊版備份 +${formatBytes(revisionDiff)}</span>`
        : '';

      return `
        <tr class="${checked ? 'is-selected' : ''}">
          <td>
            <input type="checkbox" class="drive-row-checkbox w-4 h-4 rounded accent-[#3B82F6] cursor-pointer" data-id="${escapeHtml(item.id)}" ${checked ? 'checked' : ''} aria-label="選取 ${escapeHtml(item.name)}">
          </td>
          <td>
            <div class="flex items-start gap-3 min-w-[240px]">
              <button type="button" class="w-8 h-8 rounded-lg bg-[#272727] border border-[#313131] flex items-center justify-center shrink-0 cursor-pointer hover:bg-[#3A3A3A] drive-inspect-btn" data-id="${escapeHtml(item.id)}" aria-label="開啟檢視 ${escapeHtml(item.name)}">
                <i class="ph ${getFileIconClass(item.mimeType)} text-base text-white" aria-hidden="true"></i>
              </button>
              <div class="min-w-0 space-y-1">
                <div class="flex flex-wrap items-center gap-2">
                  <button type="button" class="file-title-link truncate max-w-[300px] drive-inspect-btn" data-id="${escapeHtml(item.id)}" title="點擊查看內容：${escapeHtml(item.name)}">${escapeHtml(item.name)}</button>
                  ${dupBadgeHtml}
                  ${revBadgeHtml}
                </div>
                <div class="flex flex-wrap items-center gap-2 text-xs text-[#737373]">
                  <span>${escapeHtml(formatMimeLabel(item.mimeType))}${item.trashed ? ' · 位於垃圾桶' : ''}</span>
                  <button type="button" class="folder-chip-link drive-enter-folder-btn" data-folder-id="${escapeHtml(parentId)}" data-folder-name="${escapeHtml(folderName)}" title="點擊進入此資料夾查看其他檔案">
                    <i class="ph ph-folder text-xs" aria-hidden="true"></i>
                    <span class="truncate max-w-[160px]">${escapeHtml(folderName)}</span>
                  </button>
                </div>
              </div>
            </div>
          </td>
          <td class="font-mono-num font-semibold text-white whitespace-nowrap">${isFolder ? '目錄資料夾' : formatBytes(item.quotaBytesUsed)}</td>
          <td class="font-mono-num text-[#A3A3A3] whitespace-nowrap">${formatDateDisplay(lastDate)}</td>
          <td class="whitespace-nowrap">
            <span class="inline-flex items-center px-2 py-1 rounded-md border text-xs font-mono-num ${ageBadgeClass}">${unusedDays} 天未用</span>
          </td>
          <td class="text-right whitespace-nowrap">
            <div class="inline-flex items-center gap-2">
              <button type="button" class="btn-secondary text-xs drive-inspect-btn" data-id="${escapeHtml(item.id)}">${isFolder ? '進入查看' : '檢視／舊版'}</button>
              ${!isTrashScope ? `<button type="button" class="btn-secondary text-xs drive-single-trash-btn" data-id="${escapeHtml(item.id)}">移至垃圾桶</button>` : ''}
              <button type="button" class="btn-danger text-xs drive-single-delete-btn" data-id="${escapeHtml(item.id)}">永久刪除</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    if (state.drive.nextPageToken) {
      el.drivePaginationWrap.classList.remove('hidden');
    } else {
      el.drivePaginationWrap.classList.add('hidden');
    }

    updateDriveSelectionStats();
  }

  /* ========================================================================
     資料夾進入瀏覽 / 重複備份偵測 / 檔案預覽與歷史版本清理
     ======================================================================== */
  function updateFolderNavBar(folderId) {
    if (!el.driveFolderNavBar) return;
    if (!folderId || folderId === 'all') {
      el.driveFolderNavBar.classList.add('hidden');
      return;
    }
    const label = state.folderNameMap[folderId] || '指定資料夾';
    el.driveCurrentFolderLabel.textContent = label;
    el.driveOpenFolderExternalLink.href = folderId === 'root'
      ? 'https://drive.google.com/drive/my-drive'
      : `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
    el.driveFolderNavBar.classList.remove('hidden');
  }

  function enterDriveFolder(folderId, folderName) {
    if (!folderId) return;
    if (folderName && !state.folderNameMap[folderId]) {
      state.folderNameMap[folderId] = folderName;
    }
    if (!Array.from(el.driveFolderFilter.options).some((opt) => opt.value === folderId)) {
      const opt = document.createElement('option');
      opt.value = folderId;
      opt.textContent = state.folderNameMap[folderId] || folderName || '指定資料夾';
      el.driveFolderFilter.appendChild(opt);
    }

    el.driveFolderFilter.value = folderId;
    el.driveSizeFilter.value = '0';
    el.driveDaysFilter.value = '0';
    el.driveTypeFilter.value = 'all';
    el.driveScopeFilter.value = 'active';
    el.driveSortSelect.value = 'quotaBytesUsed desc';
    el.driveSearchInput.value = '';
    el.driveCustomSizeWrap.classList.add('hidden');
    el.driveCustomDaysWrap.classList.add('hidden');

    switchTab('drive');
    loadDriveFiles(false);
    showToast(`已進入資料夾「${state.folderNameMap[folderId] || folderName || '指定資料夾'}」檢視內容。`, 'info');
  }

  function exitDriveFolder() {
    el.driveFolderFilter.value = 'all';
    updateFolderNavBar('all');
    loadDriveFiles(false);
  }

  function normalizeFileNameForDup(rawName) {
    const name = String(rawName || '').trim();
    const lastDot = name.lastIndexOf('.');
    const base = lastDot > 0 ? name.slice(0, lastDot) : name;
    const ext = lastDot > 0 ? name.slice(lastDot).toLowerCase() : '';
    const cleanedBase = base
      .replace(/(\s*\(\d+\)|\s*-\s*複製|\s*的副本|\s*副本|\s*-\s*Copy|\s*copy\s*\d*)$/gi, '')
      .trim()
      .toLowerCase();
    return `${cleanedBase}${ext}`;
  }

  function detectDuplicateGroupsFromList(files) {
    const activeFiles = files.filter((f) => !f.trashed && f.mimeType !== 'application/vnd.google-apps.folder');
    const byKey = new Map();

    activeFiles.forEach((file) => {
      const key = file.md5Checksum && Number(file.size || 0) > 0
        ? `md5:${file.md5Checksum}`
        : `name:${normalizeFileNameForDup(file.name)}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(file);
    });

    const groups = [];
    const redundantIds = new Set();
    const keepIds = new Set();
    let redundantBytes = 0;

    byKey.forEach((list, key) => {
      if (list.length < 2) return;
      const sorted = list.slice().sort((a, b) => Date.parse(b.modifiedTime || 0) - Date.parse(a.modifiedTime || 0));
      keepIds.add(sorted[0].id);
      for (let i = 1; i < sorted.length; i++) {
        redundantIds.add(sorted[i].id);
        redundantBytes += Number(sorted[i].quotaBytesUsed || sorted[i].size || 0);
      }
      groups.push({
        key,
        reason: key.startsWith('md5:') ? '檔案內容 MD5 完全相同' : '疑似同名備份副本',
        files: sorted
      });
    });

    state.duplicates = {
      groups,
      redundantIds,
      keepIds,
      redundantBytes,
      scanned: true
    };
  }

  async function scanDuplicateBackups() {
    if (state.mode === 'guest') {
      activateDemoMode();
      await new Promise((r) => setTimeout(r, 250));
    }

    el.dupSummaryBadge.textContent = '正在掃描雲端硬碟重複備份';
    el.scanDuplicatesBtn.disabled = true;

    try {
      let pool = [];
      if (state.mode === 'demo') {
        pool = state.demoStore.driveFiles.slice();
      } else {
        const queryUrl = new URL(`${DRIVE_API_BASE}/files`);
        queryUrl.searchParams.set('q', "trashed = false and 'me' in owners and mimeType != 'application/vnd.google-apps.folder'");
        queryUrl.searchParams.set('pageSize', '200');
        queryUrl.searchParams.set('orderBy', 'quotaBytesUsed desc');
        queryUrl.searchParams.set('fields', 'files(id,name,mimeType,size,quotaBytesUsed,createdTime,modifiedTime,viewedByMeTime,parents,md5Checksum,headRevisionId,thumbnailLink,webContentLink,webViewLink,trashed)');

        const data = await googleApiFetch(queryUrl.toString());
        pool = (data.files || []).map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: Number(f.size || 0),
          quotaBytesUsed: Number(f.quotaBytesUsed || f.size || 0),
          createdTime: f.createdTime || f.modifiedTime,
          modifiedTime: f.modifiedTime,
          viewedByMeTime: f.viewedByMeTime || f.modifiedTime,
          parents: Array.isArray(f.parents) ? f.parents : ['root'],
          md5Checksum: f.md5Checksum || '',
          headRevisionId: f.headRevisionId || '',
          thumbnailLink: f.thumbnailLink || '',
          webContentLink: f.webContentLink || '',
          trashed: Boolean(f.trashed),
          webViewLink: f.webViewLink || ''
        }));

        const parentIds = Array.from(new Set(pool.flatMap((f) => f.parents || [])));
        await resolveFolderNames(parentIds);
      }

      detectDuplicateGroupsFromList(pool);

      if (state.duplicates.groups.length === 0) {
        el.dupSummaryBadge.textContent = '未發現重複副本（建議點擊檔案檢視歷史版本）';
        el.selectOldDuplicatesBtn.disabled = true;
        showToast('前 200 個主要檔案中未發現重複檔名或相同 MD5 副本；若單檔空間偏大，請直接點擊檔名清除「歷史備份版本」。', 'info');
      } else {
        el.dupSummaryBadge.textContent = `找到 ${state.duplicates.groups.length} 組重複（${state.duplicates.redundantIds.size} 個舊副本 · 可省 ${formatBytes(state.duplicates.redundantBytes)}）`;
        el.selectOldDuplicatesBtn.disabled = false;

        const flatGroupItems = state.duplicates.groups.flatMap((g) => g.files);
        state.drive.items = flatGroupItems;
        state.drive.selectedIds.clear();
        state.drive.nextPageToken = null;
        renderDriveTable();
        showToast(`已掃描並列出 ${state.duplicates.groups.length} 組重複備份檔案，可直接按「一鍵勾選多餘舊副本」。`, 'success');
      }
    } catch (err) {
      el.dupSummaryBadge.textContent = '掃描失敗';
      showToast(`掃描重複備份失敗：${err.message}`, 'error');
    } finally {
      el.scanDuplicatesBtn.disabled = false;
    }
  }

  function selectOldDuplicates() {
    if (!state.duplicates.scanned || state.duplicates.groups.length === 0) return;
    const flatGroupItems = state.duplicates.groups.flatMap((g) => g.files);
    state.drive.items = flatGroupItems;
    state.drive.selectedIds = new Set(state.duplicates.redundantIds);
    state.drive.nextPageToken = null;
    renderDriveTable();
    showToast(`已為您勾選 ${state.duplicates.redundantIds.size} 個重複舊副本（每組均保留最新一版），合計可釋放 ${formatBytes(state.duplicates.redundantBytes)}。`, 'success');
  }

  function closeFilePreviewModal() {
    state.preview.file = null;
    state.preview.revisions = [];
    el.previewFrameContainer.innerHTML = '';
    el.filePreviewModalBackdrop.classList.remove('is-open');
    el.filePreviewModalBackdrop.setAttribute('aria-hidden', 'true');
  }

  async function openFilePreviewModal(fileId) {
    const file = state.drive.items.find((f) => f.id === fileId)
      || state.insights.topFiles.find((f) => f.id === fileId)
      || state.demoStore.driveFiles.find((f) => f.id === fileId);
    if (!file) return;

    if (file.mimeType === 'application/vnd.google-apps.folder') {
      enterDriveFolder(file.id, file.name);
      return;
    }

    state.preview.file = file;
    state.preview.revisions = [];

    const parentId = Array.isArray(file.parents) && file.parents.length > 0 ? file.parents[0] : 'root';
    const folderName = state.folderNameMap[parentId] || '我的雲端硬碟根目錄';

    el.previewModalIcon.className = `ph ${getFileIconClass(file.mimeType)} text-xl text-white`;
    el.previewModalTitle.textContent = file.name;
    el.previewModalSubtitle.textContent = `${formatMimeLabel(file.mimeType)} · 位於「${folderName}」 · 步驟 1 確認 → 步驟 2 選路線 → 步驟 3 執行`;
    el.previewQuotaSize.textContent = formatBytes(file.quotaBytesUsed);
    el.previewLatestSize.textContent = file.size > 0 ? formatBytes(file.size) : 'Google 原生文件';
    el.previewFolderName.textContent = folderName;
    el.previewCreatedTime.textContent = formatDateDisplay(file.createdTime || file.modifiedTime);
    el.previewModifiedTime.textContent = formatDateDisplay(file.viewedByMeTime || file.modifiedTime);

    el.previewOpenDriveBtn.href = file.webViewLink
      || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`;
    el.previewEnterFolderBtn.dataset.folderId = parentId;
    el.previewEnterFolderBtn.dataset.folderName = folderName;

    if (state.mode === 'demo') {
      el.previewFrameContainer.innerHTML = `
        <div class="p-6 text-center space-y-3 max-w-md">
          <i class="ph ${getFileIconClass(file.mimeType)} text-4xl text-[#3B82F6]" aria-hidden="true"></i>
          <p class="text-base font-semibold text-white">${escapeHtml(file.name)}</p>
          <p class="text-xs text-[#A3A3A3]">目前處於模擬展示模式；登入真實 Google 帳號後，此區會直接內嵌 Google Drive 預覽畫面。</p>
        </div>
      `;
    } else {
      const previewUrl = `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/preview`;
      el.previewFrameContainer.innerHTML = `<iframe src="${previewUrl}" class="w-full h-full border-0" allow="autoplay" title="Google 雲端硬碟檔案預覽"></iframe>`;
    }

    el.filePreviewModalBackdrop.classList.add('is-open');
    el.filePreviewModalBackdrop.setAttribute('aria-hidden', 'false');
    el.previewRebuildCleanBtn.disabled = true;
    el.previewCleanOldRevisionsBtn.disabled = true;
    el.previewRevisionStatusBox.classList.add('hidden');
    el.previewRevErrorDetail.classList.add('hidden');
    el.previewReauthBtn.classList.add('hidden');
    el.previewRevProgressBar.style.width = '0%';
    el.previewRevProgressBar.style.backgroundColor = '#10B981';

    updatePreviewDiagnosis(file);
    await loadFileRevisions(file);
  }

  function isGooglePermissionError(msg) {
    return /insufficient|permission|scope|403|unauthorized|auth|credentials/i.test(String(msg || ''));
  }

  function updatePreviewDiagnosis(file, oldRevisions = []) {
    const quota = Number(file.quotaBytesUsed || 0);
    const latest = Number(file.size || 0);
    const revSum = oldRevisions.reduce((sum, r) => sum + (Number(r.size) || 0), 0);
    const waste = revSum > 0 ? revSum : Math.max(0, quota - latest);

    if (file.mimeType === 'application/vnd.google-apps.folder') {
      el.previewWorkflowDiagnosis.innerHTML = '<span class="text-[#A3A3A3]">資料夾本身不計算佔用容量，空間消耗來自資料夾內部檔案。</span>';
      return;
    }

    if (waste > 1048576 || oldRevisions.length > 0) {
      el.previewWorkflowDiagnosis.innerHTML = `
        <span class="text-[#F59E0B] font-semibold">容量診斷：總佔用 ${formatBytes(quota)} ＝ 最新版 ${latest > 0 ? formatBytes(latest) : '0 B'} ＋ 歷史舊備份約 ${formatBytes(waste)}</span>
        <p class="text-[#A3A3A3] mt-1">若還需要這份檔案，請選右側「路線 A · 方法 A1」只保留最新版即可立即減肥。</p>
      `;
    } else {
      el.previewWorkflowDiagnosis.innerHTML = `
        <span class="text-[#10B981] font-semibold">容量診斷：此檔案無大量舊備份冗餘（佔用 ${formatBytes(quota)}）</span>
        <p class="text-[#A3A3A3] mt-1">若已不需要此檔案，請直接使用右側「路線 B」將整份檔案移至垃圾桶或永久刪除。</p>
      `;
    }
  }

  function syncDriveFileReplacement(oldFileId, newFile) {
    state.drive.selectedIds.delete(oldFileId);

    const replaceInArray = (arr, insertIfMissing) => {
      if (!Array.isArray(arr)) return;
      const idx = arr.findIndex((item) => item.id === oldFileId);
      if (idx >= 0) {
        arr.splice(idx, 1, newFile);
      } else if (insertIfMissing) {
        arr.unshift(newFile);
      }
    };

    replaceInArray(state.drive.items, true);
    replaceInArray(state.drive.filtered, true);
    if (state.insights && Array.isArray(state.insights.topFiles)) {
      replaceInArray(state.insights.topFiles, false);
    }
  }

  async function loadFileRevisions(file) {
    el.previewRevisionCountBadge.textContent = '檢查中';
    el.previewRevisionsList.innerHTML = '<div class="skeleton-box h-12 w-full"></div>';
    el.previewCleanOldRevisionsBtn.disabled = true;
    el.previewRebuildCleanBtn.disabled = true;

    const quotaWaste = Math.max(0, Number(file.quotaBytesUsed || 0) - Number(file.size || 0));

    if (file.mimeType && file.mimeType.startsWith('application/vnd.google-apps.')) {
      el.previewRevisionCountBadge.textContent = '原生文件';
      el.previewRevisionsList.innerHTML = '<p class="text-[#A3A3A3]">Google 原生文件（如 Docs、Sheets）由 Google 統一託管版本，無獨立計費的舊版二進位備份；若要釋放空間，請確認內容後走「路線 B」刪除整份文件。</p>';
      el.previewCleanOldRevisionsBtn.innerHTML = '<i class="ph ph-broom text-sm" aria-hidden="true"></i><span>原生文件無需逐筆清理舊版</span>';
      el.previewRebuildCleanBtn.innerHTML = '<i class="ph ph-sparkle text-sm" aria-hidden="true"></i><span>原生文件無需重建</span>';
      updatePreviewDiagnosis(file, []);
      return;
    }

    try {
      let revisions = [];
      if (state.mode === 'demo') {
        await new Promise((r) => setTimeout(r, 150));
        if (file.id === 'demo_drv_rev_01') {
          const baseMs = Date.parse(file.modifiedTime);
          revisions = [
            { id: 'rev_04', modifiedTime: new Date(baseMs).toISOString(), size: 168 * 1048576, keepForever: false },
            { id: 'rev_03', modifiedTime: new Date(baseMs - 14 * 86400000).toISOString(), size: 162 * 1048576, keepForever: false },
            { id: 'rev_02', modifiedTime: new Date(baseMs - 32 * 86400000).toISOString(), size: 154 * 1048576, keepForever: false },
            { id: 'rev_01', modifiedTime: new Date(baseMs - 65 * 86400000).toISOString(), size: 148 * 1048576, keepForever: false }
          ];
          file.headRevisionId = 'rev_04';
        } else {
          revisions = [
            { id: 'rev_01', modifiedTime: file.modifiedTime, size: file.size, keepForever: false }
          ];
          file.headRevisionId = 'rev_01';
        }
      } else {
        const revUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}/revisions?pageSize=100&fields=revisions(id,modifiedTime,size,keepForever,originalFilename)`;
        const metaPromise = file.headRevisionId
          ? Promise.resolve(null)
          : googleApiFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}?fields=headRevisionId,size,quotaBytesUsed`).catch(() => null);
        const [data, meta] = await Promise.all([googleApiFetch(revUrl), metaPromise]);
        if (meta && meta.headRevisionId) {
          file.headRevisionId = meta.headRevisionId;
        }
        revisions = (data.revisions || []).slice().sort((a, b) => Date.parse(b.modifiedTime || 0) - Date.parse(a.modifiedTime || 0));
      }

      const headRevId = file.headRevisionId || (revisions[0] ? revisions[0].id : null);
      state.preview.revisions = revisions;
      const oldRevisions = revisions.filter((rev) => rev.id !== headRevId);
      const oldBytes = oldRevisions.reduce((sum, r) => sum + (Number(r.size) || 0), 0);
      const estSavings = oldBytes > 0 ? oldBytes : quotaWaste;

      el.previewRevisionCountBadge.textContent = `共 ${revisions.length} 個版本`;
      updatePreviewDiagnosis(file, oldRevisions);

      if (oldRevisions.length === 0) {
        el.previewRevisionsList.innerHTML = '<p class="text-[#A3A3A3]">此檔案目前僅有 1 個最新版本，沒有額外佔用空間的舊版歷史備份。</p>';
        el.previewCleanOldRevisionsBtn.disabled = true;
        el.previewCleanOldRevisionsBtn.innerHTML = '<i class="ph ph-broom text-sm" aria-hidden="true"></i><span>目前無舊歷史版本可清除</span>';
        const allowRebuildFallback = !file.trashed && quotaWaste > 1048576;
        el.previewRebuildCleanBtn.disabled = !allowRebuildFallback;
        el.previewRebuildCleanBtn.innerHTML = allowRebuildFallback
          ? `<i class="ph ph-sparkle text-sm" aria-hidden="true"></i><span>自動重建最新乾淨版（僅留 ${file.size > 0 ? formatBytes(file.size) : '最新版'} · 預計省下 ${formatBytes(quotaWaste)}）</span>`
          : '<i class="ph ph-sparkle text-sm" aria-hidden="true"></i><span>此檔案已是乾淨最新版，無需重建</span>';
      } else {
        el.previewRevisionsList.innerHTML = revisions.map((rev) => {
          const isHead = rev.id === headRevId;
          const sizeLabel = rev.size ? formatBytes(rev.size) : '大小未知';
          return `
            <div class="surface-card-inner flex items-center justify-between gap-2">
              <div class="min-w-0">
                <span class="font-mono-num text-white">${formatDateDisplay(rev.modifiedTime)}</span>
                <span class="ml-2 ${isHead ? 'text-[#10B981]' : 'text-[#F59E0B]'}">${isHead ? '目前最新版' : '歷史舊備份'}</span>
              </div>
              <span class="font-mono-num text-[#A3A3A3] shrink-0">${sizeLabel}</span>
            </div>
          `;
        }).join('');

        el.previewCleanOldRevisionsBtn.disabled = !!file.trashed;
        el.previewCleanOldRevisionsBtn.innerHTML = oldBytes > 0
          ? `<i class="ph ph-broom text-sm" aria-hidden="true"></i><span>逐筆刪除 ${oldRevisions.length} 個舊歷史版本（預計省下 ${formatBytes(oldBytes)}）</span>`
          : `<i class="ph ph-broom text-sm" aria-hidden="true"></i><span>逐筆刪除 ${oldRevisions.length} 個舊歷史版本（僅保留最新版）</span>`;

        el.previewRebuildCleanBtn.disabled = !!file.trashed;
        el.previewRebuildCleanBtn.innerHTML = `<i class="ph ph-sparkle text-sm" aria-hidden="true"></i><span>自動重建最新乾淨版（僅留 ${file.size > 0 ? formatBytes(file.size) : '最新版'}${estSavings > 1048576 ? ` · 預計省下 ${formatBytes(estSavings)}` : ''}）</span>`;
      }
    } catch (err) {
      el.previewRevisionCountBadge.textContent = '無法讀取';
      el.previewRevisionsList.innerHTML = `<p class="text-[#FCA5A5]">無法讀取此檔案的歷史版本：${escapeHtml(err.message)}</p>`;
      const allowRebuildFallback = !file.trashed && file.mimeType !== 'application/vnd.google-apps.folder' && quotaWaste > 1048576;
      el.previewRebuildCleanBtn.disabled = !allowRebuildFallback;
      if (allowRebuildFallback) {
        el.previewRebuildCleanBtn.innerHTML = `<i class="ph ph-sparkle text-sm" aria-hidden="true"></i><span>自動重建最新乾淨版（預計省下 ${formatBytes(quotaWaste)}）</span>`;
      }
      if (isGooglePermissionError(err.message)) {
        el.previewRevisionStatusBox.classList.remove('hidden');
        el.previewRevisionStatusBox.style.borderColor = '#7F1D1D';
        el.previewRevProgressBar.style.width = '100%';
        el.previewRevProgressBar.style.backgroundColor = '#EF4444';
        el.previewRevStatusText.textContent = '步驟 3 · 權限不足（無法存取歷史版本）';
        el.previewRevProgressCount.textContent = '403';
        el.previewRevErrorDetail.textContent = `Google API 回應原因：${err.message}。請點擊下方按鈕重新授權並勾選全部「雲端硬碟」權限。`;
        el.previewRevErrorDetail.classList.remove('hidden');
        el.previewReauthBtn.classList.remove('hidden');
      }
    }
  }

  function rebuildCleanFileWorkflow() {
    const file = state.preview.file;
    if (!file || file.trashed || file.mimeType === 'application/vnd.google-apps.folder') return;

    const headRevId = file.headRevisionId || (state.preview.revisions[0] ? state.preview.revisions[0].id : null);
    const oldRevs = state.preview.revisions.filter((rev) => rev.id !== headRevId);
    const oldBytes = oldRevs.reduce((sum, r) => sum + (Number(r.size) || 0), 0);
    const quotaWaste = Math.max(0, Number(file.quotaBytesUsed || 0) - Number(file.size || 0));
    const estSavings = oldBytes > 0 ? oldBytes : quotaWaste;

    openConfirmModal({
      title: '路線 A · 方法 A1：自動重建最新乾淨版',
      subtitle: '繞過 Google 舊版本鎖定限制，完整保留最新版內容並移除舊版冗餘容量',
      summaryHtml: `
        <p class="text-white font-semibold">目標檔案：${escapeHtml(file.name)}</p>
        <p class="text-xs text-[#A3A3A3] mt-1">1. 先以目前最新版（<span class="font-mono-num text-[#10B981]">${file.size > 0 ? formatBytes(file.size) : '最新版'}</span>）複製一份無歷史舊版的全新乾淨複本到原資料夾。</p>
        <p class="text-xs text-[#A3A3A3] mt-1">2. 再將原本含舊版冗餘的肥大舊檔（<span class="font-mono-num text-white">${formatBytes(file.quotaBytesUsed)}</span>）安全移至垃圾桶。</p>
        <p class="text-xs text-[#6EE7B7] mt-1">完成後清空垃圾桶，預計可立即釋放約 <span class="font-mono-num">${formatBytes(estSavings)}</span> 空間。</p>
      `,
      actionText: '開始執行自動重建',
      isDanger: false,
      onConfirm: async () => {
        el.previewRebuildCleanBtn.disabled = true;
        el.previewCleanOldRevisionsBtn.disabled = true;
        el.previewRebuildCleanBtn.classList.add('is-busy');

        el.previewRevisionStatusBox.classList.remove('hidden');
        el.previewRevisionStatusBox.style.borderColor = '#313131';
        el.previewRevErrorDetail.classList.add('hidden');
        el.previewReauthBtn.classList.add('hidden');
        el.previewRevStatusText.textContent = '步驟 3 · 正在執行【步驟 1/2】複製最新乾淨版檔案…';
        el.previewRevProgressCount.textContent = '0 / 2';
        el.previewRevProgressBar.style.backgroundColor = '#10B981';
        el.previewRevProgressBar.style.width = '15%';
        updateModalProgress(0, 2, '步驟 1/2：正在複製最新乾淨版檔案');

        try {
          let newFile = null;

          if (state.mode === 'demo') {
            await new Promise((r) => setTimeout(r, 250));
            el.previewRevStatusText.textContent = '步驟 3 · 正在執行【步驟 2/2】將肥大舊檔移至垃圾桶…';
            el.previewRevProgressCount.textContent = '1 / 2';
            el.previewRevProgressBar.style.width = '60%';
            updateModalProgress(1, 2, '步驟 2/2：將肥大舊檔移至垃圾桶');
            await new Promise((r) => setTimeout(r, 250));

            const demoOriginal = state.demoStore.driveFiles.find((f) => f.id === file.id);
            if (demoOriginal) demoOriginal.trashed = true;

            newFile = {
              ...file,
              id: `demo_clean_${Date.now()}`,
              size: file.size || file.quotaBytesUsed,
              quotaBytesUsed: file.size || file.quotaBytesUsed,
              createdTime: new Date().toISOString(),
              modifiedTime: file.modifiedTime || new Date().toISOString(),
              viewedByMeTime: new Date().toISOString(),
              trashed: false,
              headRevisionId: 'rev_clean_01'
            };
            state.demoStore.driveFiles.unshift(newFile);
          } else {
            const copyBody = { name: file.name };
            if (Array.isArray(file.parents) && file.parents.length > 0 && file.parents[0] !== 'root') {
              copyBody.parents = [file.parents[0]];
            }
            const copyFields = 'id,name,mimeType,size,quotaBytesUsed,createdTime,modifiedTime,viewedByMeTime,parents,webViewLink,trashed,headRevisionId';
            const copied = await googleApiFetch(
              `${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}/copy?fields=${encodeURIComponent(copyFields)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(copyBody)
              }
            );

            el.previewRevStatusText.textContent = '步驟 3 · 正在執行【步驟 2/2】將肥大舊檔移至垃圾桶…';
            el.previewRevProgressCount.textContent = '1 / 2';
            el.previewRevProgressBar.style.width = '60%';
            updateModalProgress(1, 2, '步驟 2/2：將肥大舊檔移至垃圾桶');

            try {
              await googleApiFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trashed: true })
              });
            } catch (trashErr) {
              throw new Error(`新乾淨版已建立（大小 ${formatBytes(Number(copied.size || file.size))}），但肥大舊檔移入垃圾桶時失敗：${trashErr.message}`);
            }

            newFile = {
              ...file,
              id: copied.id,
              name: copied.name || file.name,
              mimeType: copied.mimeType || file.mimeType,
              size: Number(copied.size || file.size || 0),
              quotaBytesUsed: Number(copied.quotaBytesUsed || copied.size || file.size || 0),
              createdTime: copied.createdTime || new Date().toISOString(),
              modifiedTime: copied.modifiedTime || new Date().toISOString(),
              viewedByMeTime: copied.viewedByMeTime || copied.modifiedTime || new Date().toISOString(),
              parents: Array.isArray(copied.parents) ? copied.parents : file.parents,
              webViewLink: copied.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(copied.id)}/view`,
              trashed: false,
              headRevisionId: copied.headRevisionId || undefined
            };
          }

          syncDriveFileReplacement(file.id, newFile);
          state.preview.file = newFile;
          el.previewQuotaSize.textContent = formatBytes(newFile.quotaBytesUsed);
          el.previewLatestSize.textContent = newFile.size > 0 ? formatBytes(newFile.size) : 'Google 原生文件';
          el.previewCreatedTime.textContent = formatDateDisplay(newFile.createdTime || newFile.modifiedTime);
          el.previewModifiedTime.textContent = formatDateDisplay(newFile.viewedByMeTime || newFile.modifiedTime);
          el.previewOpenDriveBtn.href = newFile.webViewLink;
          if (state.mode !== 'demo') {
            const previewUrl = `https://drive.google.com/file/d/${encodeURIComponent(newFile.id)}/preview`;
            el.previewFrameContainer.innerHTML = `<iframe src="${previewUrl}" class="w-full h-full border-0" allow="autoplay" title="Google 雲端硬碟檔案預覽"></iframe>`;
          }

          closeConfirmModal();
          await loadFileRevisions(newFile);
          renderDriveTable();
          await Promise.all([
            loadStorageQuota(),
            loadDriveInsights(),
            state.mode === 'google' && state.activeTab === 'drive' ? loadDriveFiles(false) : Promise.resolve()
          ]);

          el.previewRevisionStatusBox.classList.remove('hidden');
          el.previewRevisionStatusBox.style.borderColor = '#065F46';
          el.previewRevProgressBar.style.backgroundColor = '#10B981';
          el.previewRevProgressBar.style.width = '100%';
          el.previewRevProgressCount.textContent = '2 / 2 完成';
          el.previewRevStatusText.textContent = `步驟 3 · 已重建最新乾淨版（僅佔 ${formatBytes(newFile.quotaBytesUsed)}）！原本肥大舊檔已移入垃圾桶，請點擊上方紅色「一鍵清空雲端硬碟垃圾桶」立即釋放約 ${formatBytes(estSavings)}。`;
          showToast(`已完成乾淨版重建，肥大舊檔已移入垃圾桶！清空垃圾桶後即可釋放約 ${formatBytes(estSavings)}。`, 'success');
        } catch (err) {
          closeConfirmModal();
          el.previewRevisionStatusBox.classList.remove('hidden');
          el.previewRevisionStatusBox.style.borderColor = '#7F1D1D';
          el.previewRevProgressBar.style.backgroundColor = '#EF4444';
          el.previewRevProgressBar.style.width = '100%';
          el.previewRevProgressCount.textContent = '未能完成';
          el.previewRevStatusText.textContent = '步驟 3 · 自動重建最新乾淨版發生錯誤';
          el.previewRevErrorDetail.textContent = `Google API 回應原因：${err.message}`;
          el.previewRevErrorDetail.classList.remove('hidden');
          if (isGooglePermissionError(err.message)) {
            el.previewReauthBtn.classList.remove('hidden');
          }
          showToast(`自動重建乾淨版失敗：${err.message}`, 'error');
        } finally {
          el.previewRebuildCleanBtn.classList.remove('is-busy');
        }
      }
    });
  }

  function cleanOldRevisions() {
    const file = state.preview.file;
    const headRevId = file ? (file.headRevisionId || (state.preview.revisions[0] ? state.preview.revisions[0].id : null)) : null;
    const oldRevs = file ? state.preview.revisions.filter((rev) => rev.id !== headRevId) : [];
    if (!file || oldRevs.length === 0) return;

    const oldBytes = oldRevs.reduce((sum, r) => sum + (Number(r.size) || 0), 0);

    openConfirmModal({
      title: '路線 A · 方法 A2：逐筆清除舊歷史備份版本',
      subtitle: '保留最新一版檔案內容，嘗試逐筆刪除舊版歷史紀錄（如遭鎖定請改用方法 A1）',
      summaryHtml: `
        <p class="text-white font-semibold">目標檔案：${escapeHtml(file.name)}</p>
        <p class="text-xs text-[#A3A3A3]">即將清除 <span class="font-mono-num text-white">${oldRevs.length}</span> 個歷史舊版${oldBytes > 0 ? `（預計釋放 <span class="font-mono-num text-[#10B981]">${formatBytes(oldBytes)}</span>）` : ''}。</p>
      `,
      actionText: '確認逐筆清除舊版本',
      isDanger: true,
      onConfirm: async () => {
        let done = 0;
        let failed = 0;
        let firstErrorMsg = '';
        let hasPermissionError = false;

        el.previewCleanOldRevisionsBtn.disabled = true;
        el.previewRebuildCleanBtn.disabled = true;
        el.previewCleanOldRevisionsBtn.classList.add('is-busy');
        el.previewCleanOldRevisionsBtn.innerHTML = `<i class="ph ph-broom text-sm" aria-hidden="true"></i><span>正在執行刪除（0 / ${oldRevs.length}）</span>`;
        el.previewRevisionStatusBox.classList.remove('hidden');
        el.previewRevisionStatusBox.style.borderColor = '#313131';
        el.previewRevErrorDetail.classList.add('hidden');
        el.previewReauthBtn.classList.add('hidden');
        el.previewRevStatusText.textContent = '步驟 3 · 正在逐批清除舊歷史版本…';
        el.previewRevProgressCount.textContent = `0 / ${oldRevs.length}`;
        el.previewRevProgressBar.style.backgroundColor = '#10B981';
        el.previewRevProgressBar.style.width = '0%';
        updateModalProgress(0, oldRevs.length, '正在清除舊歷史備份版本');

        function reportProgress() {
          const pct = oldRevs.length > 0 ? Math.round((done / oldRevs.length) * 100) : 100;
          updateModalProgress(done, oldRevs.length, `正在清除舊歷史備份版本（${done} / ${oldRevs.length}）`);
          el.previewCleanOldRevisionsBtn.innerHTML = `<i class="ph ph-broom text-sm" aria-hidden="true"></i><span>正在執行刪除（${done} / ${oldRevs.length}）</span>`;
          el.previewRevProgressCount.textContent = `${done} / ${oldRevs.length}`;
          el.previewRevProgressBar.style.width = `${pct}%`;
        }

        if (state.mode === 'demo') {
          for (let i = 0; i < oldRevs.length; i++) {
            await new Promise((r) => setTimeout(r, 80));
            done++;
            reportProgress();
          }
          const demoTarget = state.demoStore.driveFiles.find((f) => f.id === file.id);
          if (demoTarget) demoTarget.quotaBytesUsed = demoTarget.size;
          file.quotaBytesUsed = file.size;
        } else {
          await runWithConcurrency(oldRevs, 5, async (rev) => {
            try {
              if (rev.keepForever) {
                await googleApiFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}/revisions/${encodeURIComponent(rev.id)}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ keepForever: false })
                });
              }
              await googleApiFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}/revisions/${encodeURIComponent(rev.id)}`, {
                method: 'DELETE'
              });
            } catch (err) {
              failed++;
              const msg = String(err && err.message ? err.message : err || '');
              if (!firstErrorMsg && msg) firstErrorMsg = msg;
              if (isGooglePermissionError(msg)) hasPermissionError = true;
              console.error('清除 revision 失敗', rev.id, err);
            }
            done++;
            reportProgress();
          });

          try {
            const refreshed = await googleApiFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}?fields=size,quotaBytesUsed`);
            file.size = Number(refreshed.size || file.size);
            file.quotaBytesUsed = Number(refreshed.quotaBytesUsed || file.size);
          } catch {
            // 忽略重新讀取單檔容量錯誤
          }
        }

        el.previewCleanOldRevisionsBtn.classList.remove('is-busy');
        closeConfirmModal();
        await loadFileRevisions(file);
        el.previewQuotaSize.textContent = formatBytes(file.quotaBytesUsed);

        const deletedOk = oldRevs.length - failed;
        el.previewRevisionStatusBox.classList.remove('hidden');
        el.previewRevProgressBar.style.width = '100%';
        el.previewRevProgressCount.textContent = `${deletedOk} / ${oldRevs.length} 完成`;

        if (failed > 0) {
          el.previewRevisionStatusBox.style.borderColor = deletedOk === 0 ? '#7F1D1D' : '#78350F';
          el.previewRevProgressBar.style.backgroundColor = deletedOk === 0 ? '#EF4444' : '#F59E0B';
          el.previewRevStatusText.textContent = `步驟 3 · 成功清除 ${deletedOk} 個舊版，另有 ${failed} 個未能就地刪除。`;
          if (hasPermissionError) {
            el.previewRevErrorDetail.textContent = `Google API 回應原因：${firstErrorMsg || '權限不足'}。這通常代表登入時未勾選完整的「雲端硬碟」編輯與刪除核取方塊，請點擊下方按鈕重新授權，或直接點上方綠色「方法 A1 · 自動重建最新乾淨版」。`;
            el.previewReauthBtn.classList.remove('hidden');
          } else {
            el.previewRevErrorDetail.textContent = `Google API 回應原因：${firstErrorMsg || 'Google 不允許逐筆刪除該二進位檔的歷史版本'}。建議直接點擊上方綠色按鈕「方法 A1 · 自動重建最新乾淨版」，即可 100% 繞過此限制並省下舊版容量！`;
            el.previewReauthBtn.classList.add('hidden');
          }
          el.previewRevErrorDetail.classList.remove('hidden');
        } else {
          el.previewRevisionStatusBox.style.borderColor = '#065F46';
          el.previewRevProgressBar.style.backgroundColor = '#10B981';
          el.previewRevErrorDetail.classList.add('hidden');
          el.previewReauthBtn.classList.add('hidden');
          el.previewRevStatusText.textContent = `步驟 3 · 已完成清除：成功刪除 ${deletedOk} 個舊歷史版本${oldBytes > 0 ? `（釋放約 ${formatBytes(oldBytes)}）` : ''}，僅保留最新版。`;
        }

        renderDriveTable();
        await Promise.all([loadStorageQuota(), loadDriveInsights()]);
        showToast(
          failed > 0
            ? `完成檢查：成功刪除 ${deletedOk} 個舊版本，${failed} 個無法就地刪除；建議點擊上方「方法 A1 · 自動重建最新乾淨版」。`
            : `完成刪除：已成功清除 ${deletedOk} 個舊歷史備份版本${oldBytes > 0 ? `（省下約 ${formatBytes(oldBytes)}）` : ''}。`,
          failed > 0 ? 'warning' : 'success'
        );
      }
    });
  }

  /* ========================================================================
     Gmail 篩選與清理模組
     ======================================================================== */
  function buildGmailSearchQuery() {
    const parts = [];
    const sizeMode = el.gmailSizeFilter.value;
    const minMB = sizeMode === 'custom'
      ? Math.max(0, Number(el.gmailCustomSizeInput.value) || 0)
      : Number(sizeMode) || 0;

    if (minMB > 0) {
      parts.push(`larger:${Math.floor(minMB)}M`);
    }

    const daysMode = el.gmailDaysFilter.value;
    const minDays = daysMode === 'custom'
      ? Math.max(0, Number(el.gmailCustomDaysInput.value) || 0)
      : Number(daysMode) || 0;

    if (minDays > 0) {
      parts.push(`older_than:${Math.floor(minDays)}d`);
    }

    const cat = el.gmailCategoryFilter.value;
    if (cat && cat !== 'all') {
      parts.push(cat);
    }

    const keyword = el.gmailSearchInput.value.trim();
    if (keyword) {
      parts.push(keyword);
    }

    const queryStr = parts.join(' ').trim();
    el.gmailQueryPreview.textContent = queryStr || '全部郵件（無篩選條件）';
    return queryStr;
  }

  function renderGmailSkeleton() {
    const rows = Array.from({ length: 5 }, () => `
      <tr>
        <td><div class="skeleton-box w-4 h-4"></div></td>
        <td><div class="skeleton-box h-5 w-72"></div></td>
        <td><div class="skeleton-box h-5 w-36"></div></td>
        <td><div class="skeleton-box h-5 w-20"></div></td>
        <td><div class="skeleton-box h-5 w-28"></div></td>
        <td class="text-right"><div class="skeleton-box h-7 w-24 ml-auto"></div></td>
      </tr>
    `).join('');
    el.gmailTableBody.innerHTML = rows;
  }

  async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;

    async function runner() {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => runner());
    await Promise.all(workers);
    return results;
  }

  async function loadGmailMessages(append = false) {
    const queryStr = buildGmailSearchQuery();
    if (state.mode === 'guest') {
      renderGmailTable();
      return;
    }

    state.gmail.loading = true;
    if (!append) {
      state.gmail.items = [];
      state.gmail.selectedIds.clear();
      state.gmail.nextPageToken = null;
      renderGmailSkeleton();
    }

    try {
      if (state.mode === 'demo') {
        await new Promise((r) => setTimeout(r, 240));
        const sizeMode = el.gmailSizeFilter.value;
        const minMB = sizeMode === 'custom'
          ? Math.max(0, Number(el.gmailCustomSizeInput.value) || 0)
          : Number(sizeMode) || 0;
        const minBytes = minMB * 1048576;

        const daysMode = el.gmailDaysFilter.value;
        const minDays = daysMode === 'custom'
          ? Math.max(0, Number(el.gmailCustomDaysInput.value) || 0)
          : Number(daysMode) || 0;

        const cat = el.gmailCategoryFilter.value;
        const keyword = el.gmailSearchInput.value.trim().toLowerCase();

        const filtered = state.demoStore.gmailMessages.filter((msg) => {
          if (cat === 'in:trash' && !msg.inTrash) return false;
          if (cat !== 'in:trash' && msg.inTrash) return false;
          if (cat === 'has:attachment' && !msg.hasAttachment) return false;
          if (cat.startsWith('category:') && msg.category !== cat.split(':')[1]) return false;
          if (minBytes > 0 && msg.sizeEstimate < minBytes) return false;
          if (minDays > 0 && calcDaysAgo(msg.internalDate) < minDays) return false;
          if (keyword && !(msg.subject + msg.from + msg.snippet).toLowerCase().includes(keyword)) return false;
          return true;
        });

        sortGmailList(filtered);
        state.gmail.items = filtered;
        state.gmail.nextPageToken = null;
      } else {
        const listUrl = new URL(`${GMAIL_API_BASE}/messages`);
        if (queryStr) listUrl.searchParams.set('q', queryStr);
        listUrl.searchParams.set('maxResults', '40');
        if (el.gmailCategoryFilter.value === 'in:trash') {
          listUrl.searchParams.set('includeSpamTrash', 'true');
        }
        if (append && state.gmail.nextPageToken) {
          listUrl.searchParams.set('pageToken', state.gmail.nextPageToken);
        }

        const listData = await googleApiFetch(listUrl.toString());
        const refs = listData.messages || [];

        const detailed = await runWithConcurrency(refs, 8, async (ref) => {
          const detailUrl = `${GMAIL_API_BASE}/messages/${encodeURIComponent(ref.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`;
          const msg = await googleApiFetch(detailUrl);
          const headers = msg.payload?.headers || [];
          const getHeader = (name) => {
            const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
            return found ? found.value : '';
          };
          const rawUnsub = getHeader('List-Unsubscribe');
          return {
            id: msg.id,
            subject: getHeader('Subject') || '（無主旨信件）',
            from: getHeader('From') || '未知寄件者',
            internalDate: Number(msg.internalDate || Date.now()),
            sizeEstimate: Number(msg.sizeEstimate || 0),
            inTrash: Array.isArray(msg.labelIds) && msg.labelIds.includes('TRASH'),
            snippet: msg.snippet || '',
            unsubInfo: parseUnsubscribeHeader(rawUnsub)
          };
        });

        const merged = append ? state.gmail.items.concat(detailed) : detailed;
        sortGmailList(merged);
        state.gmail.items = merged;
        state.gmail.nextPageToken = listData.nextPageToken || null;
      }
    } catch (err) {
      showToast(`讀取 Gmail 信件失敗：${err.message}`, 'error');
    } finally {
      state.gmail.loading = false;
      renderGmailTable();
    }
  }

  function parseUnsubscribeHeader(headerVal) {
    if (!headerVal || typeof headerVal !== 'string') return null;
    let httpUrl = null;
    let mailtoUrl = null;
    const items = headerVal.match(/<([^>]+)>/g) || [headerVal];
    for (const item of items) {
      const clean = item.replace(/[<>]/g, '').trim();
      if (/^https?:\/\//i.test(clean) && !httpUrl) {
        httpUrl = clean;
      } else if (/^mailto:/i.test(clean) && !mailtoUrl) {
        mailtoUrl = clean;
      }
    }
    if (!httpUrl && !mailtoUrl) return null;
    return {
      httpUrl,
      mailtoUrl,
      type: httpUrl ? 'web' : 'mail'
    };
  }

  function parseSender(fromStr) {
    const raw = String(fromStr || '').trim();
    if (!raw) return { name: '未知寄件者', email: '' };
    const match = raw.match(/^(.*?)(?:<([^>]+)>)?$/);
    if (match) {
      const name = (match[1] || '').replace(/['"]/g, '').trim();
      const email = (match[2] || '').trim();
      if (email) {
        return { name: name || email.split('@')[0], email };
      }
      if (raw.includes('@')) {
        return { name: raw.split('@')[0], email: raw };
      }
      return { name: raw, email: '' };
    }
    return { name: raw, email: '' };
  }

  function groupGmailBySender(items) {
    const map = new Map();
    for (const msg of items) {
      const sender = parseSender(msg.from);
      const key = (sender.email || sender.name || 'unknown').toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          key,
          name: sender.name,
          email: sender.email,
          messages: [],
          totalBytes: 0,
          latestDate: 0,
          unsubInfo: msg.unsubInfo || null
        });
      }
      const g = map.get(key);
      g.messages.push(msg);
      g.totalBytes += Number(msg.sizeEstimate || 0);
      if (msg.internalDate > g.latestDate) {
        g.latestDate = msg.internalDate;
      }
      if (!g.unsubInfo && msg.unsubInfo) {
        g.unsubInfo = msg.unsubInfo;
      }
    }

    const groups = Array.from(map.values());
    const sortVal = el.gmailSortSelect.value;
    groups.sort((a, b) => {
      if (sortVal === 'sizeAsc') return a.totalBytes - b.totalBytes;
      if (sortVal === 'dateAsc') return a.latestDate - b.latestDate;
      if (sortVal === 'dateDesc') return b.latestDate - a.latestDate;
      if (sortVal === 'fromAsc') return a.name.localeCompare(b.name, 'zh-Hant');
      if (sortVal === 'fromDesc') return b.name.localeCompare(a.name, 'zh-Hant');
      return b.totalBytes - a.totalBytes;
    });

    return groups;
  }

  function renderGmailTable() {
    if (state.gmail.activeSubtab === 'subscriptions') {
      return;
    }

    if (state.mode === 'guest') {
      const guestHtml = `
        <div class="surface-card-compact py-12 text-center">
          <div class="space-y-3 max-w-md mx-auto">
            <p class="text-base font-semibold text-white">尚未載入 Gmail 郵件清單</p>
            <p class="text-sm text-[#A3A3A3]">請返回「使用量總覽」登入 Google 帳號並授權 Gmail 權限，或啟動模擬展示模式體驗。</p>
          </div>
        </div>
      `;
      el.gmailGroupedContainer.innerHTML = guestHtml;
      el.gmailTableBody.innerHTML = `<tr><td colspan="6" class="py-12 text-center text-[#A3A3A3]">尚未載入 Gmail 郵件清單</td></tr>`;
      el.gmailPaginationWrap.classList.add('hidden');
      updateGmailSelectionStats();
      return;
    }

    if (state.gmail.items.length === 0) {
      const emptyHtml = `
        <div class="surface-card-compact py-12 text-center">
          <div class="space-y-2 max-w-md mx-auto">
            <p class="text-base font-semibold text-white">沒有符合此查詢條件的 Gmail 信件</p>
            <p class="text-sm text-[#A3A3A3]">建議調降 MB 門檻或縮短存放天數後再點擊「搜尋符合信件」。</p>
          </div>
        </div>
      `;
      el.gmailGroupedContainer.innerHTML = emptyHtml;
      el.gmailTableBody.innerHTML = `<tr><td colspan="6" class="py-12 text-center text-[#A3A3A3]">沒有符合條件的信件</td></tr>`;
      el.gmailPaginationWrap.classList.add('hidden');
      updateGmailSelectionStats();
      return;
    }

    if (state.gmail.viewMode === 'grouped') {
      el.gmailGroupedWrap.classList.remove('hidden');
      el.gmailFlatWrap.classList.add('hidden');
      renderGmailGroupedTable();
    } else {
      el.gmailGroupedWrap.classList.add('hidden');
      el.gmailFlatWrap.classList.remove('hidden');
      renderGmailFlatTable();
    }

    if (state.gmail.nextPageToken) {
      el.gmailPaginationWrap.classList.remove('hidden');
    } else {
      el.gmailPaginationWrap.classList.add('hidden');
    }

    updateGmailSelectionStats();
  }

  function renderGmailGroupedTable() {
    const groups = groupGmailBySender(state.gmail.items);
    const isTrashScope = el.gmailCategoryFilter.value === 'in:trash';

    el.gmailGroupedContainer.innerHTML = groups.map((g, idx) => {
      // 預設前 3 個大群組自動展開，其餘依照使用者記錄收合
      const isExpanded = !state.gmail.collapsedSenders.has(g.key);
      const allChecked = g.messages.length > 0 && g.messages.every((m) => state.gmail.selectedIds.has(m.id));
      const someChecked = !allChecked && g.messages.some((m) => state.gmail.selectedIds.has(m.id));

      const itemsHtml = g.messages.map((msg) => {
        const checked = state.gmail.selectedIds.has(msg.id);
        const daysAgo = calcDaysAgo(msg.internalDate);
        const ageBadgeClass = daysAgo >= 365
          ? 'bg-[#3B1212] border-[#7F1D1D] text-[#FCA5A5]'
          : daysAgo >= 180
            ? 'bg-[#451A03] border-[#78350F] text-[#FCD34D]'
            : 'bg-[#272727] border-[#313131] text-[#A3A3A3]';

        return `
          <div class="sender-group-item ${checked ? 'is-selected' : ''}">
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <input type="checkbox" class="gmail-row-checkbox w-4 h-4 rounded accent-[#3B82F6] cursor-pointer shrink-0"
                data-id="${escapeHtml(msg.id)}" ${checked ? 'checked' : ''} aria-label="選取信件 ${escapeHtml(msg.subject)}">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-semibold text-white truncate text-sm" title="${escapeHtml(msg.subject)}">${escapeHtml(msg.subject)}</span>
                  ${msg.unsubInfo ? `<span class="unsub-badge-web text-[10px] py-0 px-1.5"><i class="ph ph-bell-slash"></i>可退訂</span>` : ''}
                </div>
                <p class="text-xs text-[#737373] truncate mt-0.5">${escapeHtml(msg.snippet)}</p>
              </div>
            </div>

            <div class="flex items-center gap-4 shrink-0 text-xs">
              <span class="font-mono-num font-semibold text-white whitespace-nowrap">${formatBytes(msg.sizeEstimate)}</span>
              <div class="flex items-center gap-1.5 whitespace-nowrap">
                <span class="font-mono-num text-[#A3A3A3]">${formatDateDisplay(msg.internalDate)}</span>
                <span class="px-1.5 py-0.5 rounded border font-mono-num ${ageBadgeClass}">${daysAgo} 天</span>
              </div>
              <div class="inline-flex items-center gap-1.5">
                ${!isTrashScope ? `<button type="button" class="btn-secondary text-xs p-1.5 gmail-single-trash-btn" data-id="${escapeHtml(msg.id)}" title="移至垃圾桶"><i class="ph ph-trash" aria-hidden="true"></i></button>` : ''}
                <button type="button" class="btn-danger text-xs p-1.5 gmail-single-delete-btn" data-id="${escapeHtml(msg.id)}" title="永久刪除"><i class="ph ph-x-circle" aria-hidden="true"></i></button>
              </div>
            </div>
          </div>
        `;
      }).join('');

      return `
        <div class="sender-group-card ${isExpanded ? 'is-expanded' : ''}" data-sender-key="${escapeHtml(g.key)}">
          <div class="sender-group-header">
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <span class="sender-group-arrow">
                <i class="ph ph-caret-right text-base" aria-hidden="true"></i>
              </span>
              <input type="checkbox" class="sender-group-select-checkbox w-4 h-4 rounded accent-[#3B82F6] cursor-pointer shrink-0"
                data-sender-key="${escapeHtml(g.key)}" ${allChecked ? 'checked' : ''} aria-label="全選寄件者 ${escapeHtml(g.name)} 的信件">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <strong class="text-white text-sm truncate">${escapeHtml(g.name)}</strong>
                  ${g.email ? `<span class="text-xs text-[#A3A3A3] truncate font-mono">&lt;${escapeHtml(g.email)}&gt;</span>` : ''}
                  <span class="px-2 py-0.5 rounded-md bg-[#272727] border border-[#313131] text-xs font-mono-num text-white">${g.messages.length} 封信件</span>
                  <span class="px-2 py-0.5 rounded-md bg-[#064E3B] border border-[#059669] text-xs font-mono-num text-[#6EE7B7]">${formatBytes(g.totalBytes)}</span>
                </div>
              </div>
            </div>

            <div class="flex items-center gap-2 shrink-0">
              <span class="text-xs text-[#737373] hidden sm:inline-block font-mono-num">最新：${formatDateDisplay(g.latestDate)}</span>
              ${g.unsubInfo ? `
                <button type="button" class="btn-secondary text-xs sub-quick-unsub-btn" data-sender-key="${escapeHtml(g.key)}" title="點擊取消訂閱此電子報">
                  <i class="ph ph-bell-slash text-xs" aria-hidden="true"></i>
                  <span>退訂</span>
                </button>
              ` : ''}
              ${!isTrashScope ? `
                <button type="button" class="btn-secondary text-xs sender-group-trash-btn" data-sender-key="${escapeHtml(g.key)}" title="將此寄件者的全部信件移入垃圾桶">
                  <i class="ph ph-trash text-xs" aria-hidden="true"></i>
                  <span>清入垃圾桶</span>
                </button>
              ` : ''}
              <button type="button" class="btn-danger text-xs sender-group-delete-btn" data-sender-key="${escapeHtml(g.key)}" title="永久刪除此寄件者所有信件">
                <i class="ph ph-x-circle text-xs" aria-hidden="true"></i>
                <span>清空刪除</span>
              </button>
            </div>
          </div>

          <div class="sender-group-content">
            ${itemsHtml}
          </div>
        </div>
      `;
    }).join('');
  }

  function renderGmailFlatTable() {
    const isTrashScope = el.gmailCategoryFilter.value === 'in:trash';

    el.gmailTableBody.innerHTML = state.gmail.items.map((msg) => {
      const checked = state.gmail.selectedIds.has(msg.id);
      const daysAgo = calcDaysAgo(msg.internalDate);
      const ageBadgeClass = daysAgo >= 365
        ? 'bg-[#3B1212] border-[#7F1D1D] text-[#FCA5A5]'
        : daysAgo >= 180
          ? 'bg-[#451A03] border-[#78350F] text-[#FCD34D]'
          : 'bg-[#272727] border-[#313131] text-[#A3A3A3]';

      return `
        <tr class="${checked ? 'is-selected' : ''}">
          <td>
            <input type="checkbox" class="gmail-row-checkbox w-4 h-4 rounded accent-[#3B82F6] cursor-pointer" data-id="${escapeHtml(msg.id)}" ${checked ? 'checked' : ''} aria-label="選取信件 ${escapeHtml(msg.subject)}">
          </td>
          <td>
            <div class="min-w-[220px] max-w-[360px]">
              <div class="flex items-center gap-2">
                <p class="font-semibold text-white truncate" title="${escapeHtml(msg.subject)}">${escapeHtml(msg.subject)}</p>
                ${msg.unsubInfo ? `<span class="unsub-badge-web text-[10px] py-0 px-1.5"><i class="ph ph-bell-slash"></i>可退訂</span>` : ''}
              </div>
              <p class="text-xs text-[#737373] truncate mt-0.5">${escapeHtml(msg.snippet)}</p>
            </div>
          </td>
          <td class="text-xs text-[#A3A3A3] max-w-[200px] truncate" title="${escapeHtml(msg.from)}">${escapeHtml(msg.from)}</td>
          <td class="font-mono-num font-semibold text-white whitespace-nowrap">${formatBytes(msg.sizeEstimate)}</td>
          <td class="whitespace-nowrap">
            <div class="flex items-center gap-2">
              <span class="font-mono-num text-xs text-[#A3A3A3]">${formatDateDisplay(msg.internalDate)}</span>
              <span class="px-2 py-0.5 rounded-md border text-xs font-mono-num ${ageBadgeClass}">${daysAgo} 天</span>
            </div>
          </td>
          <td class="text-right whitespace-nowrap">
            <div class="inline-flex items-center gap-2">
              ${!isTrashScope ? `<button type="button" class="btn-secondary text-xs gmail-single-trash-btn" data-id="${escapeHtml(msg.id)}">移至垃圾桶</button>` : ''}
              <button type="button" class="btn-danger text-xs gmail-single-delete-btn" data-id="${escapeHtml(msg.id)}">永久刪除</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  /* ========================================================================
     Gmail 電子報與訂閱帳戶管理模組
     ======================================================================== */
  function switchGmailSubtab(subtab) {
    state.gmail.activeSubtab = subtab;
    const isCleaner = subtab === 'cleaner';
    el.gmailSubtabCleanerBtn.classList.toggle('is-active', isCleaner);
    el.gmailSubtabSubscriptionsBtn.classList.toggle('is-active', !isCleaner);
    el.gmailCleanerPanel.classList.toggle('hidden', !isCleaner);
    el.gmailSubscriptionsPanel.classList.toggle('hidden', isCleaner);

    if (!isCleaner && state.gmail.subscriptions.length === 0) {
      scanGmailSubscriptions();
    }
  }

  async function scanGmailSubscriptions() {
    if (state.mode === 'guest') {
      showToast('請先登入 Google 帳號或啟動展示模式以管理訂閱帳戶。', 'warning');
      return;
    }
    state.gmail.subsLoading = true;
    el.subScanBtn.classList.add('is-busy');
    el.subScanBtn.disabled = true;
    el.subTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="py-12 text-center text-[#A3A3A3]">
          <div class="space-y-3 max-w-md mx-auto">
            <p class="text-base font-semibold text-white">正在智慧掃描促銷、通知與具備退訂標頭的郵件來源…</p>
            <div class="quota-bar-track" style="height: 8px;"><div class="quota-segment bg-[#3B82F6]" style="width: 100%;"></div></div>
          </div>
        </td>
      </tr>
    `;

    try {
      let subs = [];
      if (state.mode === 'demo') {
        await new Promise((r) => setTimeout(r, 260));
        const promoMessages = state.demoStore.gmailMessages.filter((m) =>
          !m.inTrash && (m.category === 'promotions' || m.category === 'social' || m.unsubInfo ||
            (m.subject + m.snippet).toLowerCase().includes('unsubscribe') ||
            (m.subject + m.snippet).toLowerCase().includes('退訂') ||
            (m.subject + m.snippet).toLowerCase().includes('電子報'))
        );
        const map = new Map();
        for (const msg of promoMessages) {
          const sender = parseSender(msg.from);
          const key = (sender.email || sender.name).toLowerCase();
          if (!map.has(key)) {
            map.set(key, {
              key,
              name: sender.name,
              email: sender.email,
              count: 0,
              totalBytes: 0,
              messageIds: [],
              unsubInfo: msg.unsubInfo || null
            });
          }
          const s = map.get(key);
          s.count++;
          s.totalBytes += Number(msg.sizeEstimate || 0);
          s.messageIds.push(msg.id);
          if (!s.unsubInfo && msg.unsubInfo) s.unsubInfo = msg.unsubInfo;
        }
        subs = Array.from(map.values()).sort((a, b) => b.totalBytes - a.totalBytes);
      } else {
        const query = 'category:promotions OR category:updates OR category:social OR unsubscribe';
        const listUrl = `${GMAIL_API_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=60`;
        const listData = await googleApiFetch(listUrl);
        const refs = listData.messages || [];

        const detailed = await runWithConcurrency(refs, 8, async (ref) => {
          const detailUrl = `${GMAIL_API_BASE}/messages/${encodeURIComponent(ref.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`;
          const msg = await googleApiFetch(detailUrl);
          const headers = msg.payload?.headers || [];
          const getHeader = (name) => {
            const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
            return found ? found.value : '';
          };
          const rawUnsub = getHeader('List-Unsubscribe');
          return {
            id: msg.id,
            from: getHeader('From') || '未知寄件者',
            sizeEstimate: Number(msg.sizeEstimate || 0),
            unsubInfo: parseUnsubscribeHeader(rawUnsub)
          };
        });

        const map = new Map();
        for (const msg of detailed) {
          const sender = parseSender(msg.from);
          const key = (sender.email || sender.name).toLowerCase();
          if (!map.has(key)) {
            map.set(key, {
              key,
              name: sender.name,
              email: sender.email,
              count: 0,
              totalBytes: 0,
              messageIds: [],
              unsubInfo: msg.unsubInfo || null
            });
          }
          const s = map.get(key);
          s.count++;
          s.totalBytes += Number(msg.sizeEstimate || 0);
          s.messageIds.push(msg.id);
          if (!s.unsubInfo && msg.unsubInfo) s.unsubInfo = msg.unsubInfo;
        }
        subs = Array.from(map.values()).sort((a, b) => b.totalBytes - a.totalBytes);
      }

      state.gmail.subscriptions = subs;
      renderGmailSubscriptions();
      showToast(`已成功掃描出 ${subs.length} 個訂閱帳戶與通知來源。`, 'success');
    } catch (err) {
      showToast(`掃描訂閱帳戶失敗：${err.message}`, 'error');
      el.subTableBody.innerHTML = `
        <tr>
          <td colspan="6" class="py-12 text-center text-[#FCA5A5]">掃描失敗：${escapeHtml(err.message)}</td>
        </tr>
      `;
    } finally {
      state.gmail.subsLoading = false;
      el.subScanBtn.classList.remove('is-busy');
      el.subScanBtn.disabled = false;
    }
  }

  function renderGmailSubscriptions() {
    const subs = state.gmail.subscriptions;
    const totalCount = subs.length;
    const messageCount = subs.reduce((sum, s) => sum + s.count, 0);
    const totalBytes = subs.reduce((sum, s) => sum + s.totalBytes, 0);
    const unsubCount = subs.filter((s) => s.unsubInfo).length;

    el.subStatsTotalCount.textContent = String(totalCount);
    el.subStatsMessageCount.textContent = String(messageCount);
    el.subStatsTotalBytes.textContent = formatBytes(totalBytes);
    el.subStatsUnsubCount.textContent = String(unsubCount);

    if (subs.length === 0) {
      el.subTableBody.innerHTML = `
        <tr>
          <td colspan="6" class="py-12 text-center text-[#A3A3A3]">
            <p class="text-white font-semibold mb-1">未發現大量累積的訂閱帳戶或電子報信件</p>
            <p class="text-xs">若有特定外部服務，可於信件清理搜尋中輸入該來源信箱直接篩選處理。</p>
          </td>
        </tr>
      `;
      return;
    }

    el.subTableBody.innerHTML = subs.map((s) => {
      let badgeHtml = '';
      if (s.unsubInfo?.httpUrl) {
        badgeHtml = `<span class="unsub-badge-web"><i class="ph ph-globe" aria-hidden="true"></i>支援網頁一鍵退訂</span>`;
      } else if (s.unsubInfo?.mailtoUrl) {
        badgeHtml = `<span class="unsub-badge-mail"><i class="ph ph-envelope-simple" aria-hidden="true"></i>支援郵件退訂</span>`;
      } else {
        badgeHtml = `<span class="unsub-badge-manual"><i class="ph ph-magnifying-glass" aria-hidden="true"></i>無退訂標頭（可一鍵搜尋封鎖）</span>`;
      }

      return `
        <tr class="sub-account-row" data-sender-key="${escapeHtml(s.key)}">
          <td>
            <div class="flex items-center gap-2">
              <span class="w-7 h-7 rounded-md bg-[#272727] border border-[#313131] flex items-center justify-center shrink-0">
                <i class="ph ph-bell-simple text-sm text-[#A3A3A3]" aria-hidden="true"></i>
              </span>
              <strong class="text-white text-sm truncate max-w-[200px]" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</strong>
            </div>
          </td>
          <td>
            <span class="font-mono text-xs text-[#A3A3A3] truncate block max-w-[220px]" title="${escapeHtml(s.email)}">${escapeHtml(s.email || '未提供獨立信箱')}</span>
          </td>
          <td>
            <span class="font-mono-num font-semibold text-white whitespace-nowrap">${s.count} 封</span>
          </td>
          <td>
            <span class="font-mono-num font-semibold text-[#10B981] whitespace-nowrap">${formatBytes(s.totalBytes)}</span>
          </td>
          <td class="whitespace-nowrap">
            ${badgeHtml}
          </td>
          <td class="text-right whitespace-nowrap">
            <div class="inline-flex items-center gap-2">
              ${s.unsubInfo ? `
                <button type="button" class="btn-success text-xs sub-action-unsub-btn" data-sender-key="${escapeHtml(s.key)}">
                  <i class="ph ph-bell-slash text-xs" aria-hidden="true"></i>
                  <span>取消訂閱</span>
                </button>
              ` : `
                <button type="button" class="btn-secondary text-xs sub-action-search-btn" data-sender-key="${escapeHtml(s.key)}" data-sender-email="${escapeHtml(s.email)}">
                  <i class="ph ph-magnifying-glass text-xs" aria-hidden="true"></i>
                  <span>搜尋此寄件者</span>
                </button>
              `}
              <button type="button" class="btn-secondary text-xs sub-action-trash-btn" data-sender-key="${escapeHtml(s.key)}">
                <span>清入垃圾桶</span>
              </button>
              <button type="button" class="btn-danger text-xs sub-action-delete-btn" data-sender-key="${escapeHtml(s.key)}">
                <span>永久刪除</span>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function handleUnsubscribe(sub) {
    if (!sub || !sub.unsubInfo) {
      showToast('此寄件者未提供標準退訂標頭，建議搜尋該寄件者建立 Gmail 封鎖篩選器。', 'info');
      return;
    }
    const { httpUrl, mailtoUrl } = sub.unsubInfo;
    if (httpUrl) {
      window.open(httpUrl, '_blank', 'noopener,noreferrer');
      showToast(`已在新分頁開啟「${sub.name}」的取消訂閱頁面，請於該頁面確認取消訂閱。`, 'success');
    } else if (mailtoUrl) {
      window.location.href = mailtoUrl;
      showToast(`已開啟郵件軟體向「${sub.name}」發送取消訂閱請求郵件。`, 'info');
    }
  }

  function cleanupSubscriptionMessages(senderKey, permanent) {
    const sub = state.gmail.subscriptions.find((s) => s.key === senderKey);
    if (!sub || sub.messageIds.length === 0) return;
    executeGmailDeletion(sub.messageIds, permanent);
  }

  function sortGmailList(list) {
    const mode = el.gmailSortSelect.value;
    list.sort((a, b) => {
      if (mode === 'sizeDesc') return (Number(b.sizeEstimate) || 0) - (Number(a.sizeEstimate) || 0);
      if (mode === 'sizeAsc') return (Number(a.sizeEstimate) || 0) - (Number(b.sizeEstimate) || 0);
      if (mode === 'dateAsc') return (Number(a.internalDate) || 0) - (Number(b.internalDate) || 0);
      if (mode === 'dateDesc') return (Number(b.internalDate) || 0) - (Number(a.internalDate) || 0);
      if (mode === 'subjectAsc') return (a.subject || '').localeCompare(b.subject || '', 'zh-Hant', { numeric: true });
      if (mode === 'subjectDesc') return (b.subject || '').localeCompare(a.subject || '', 'zh-Hant', { numeric: true });
      if (mode === 'fromAsc') return (a.from || '').localeCompare(b.from || '', 'zh-Hant', { numeric: true });
      if (mode === 'fromDesc') return (b.from || '').localeCompare(a.from || '', 'zh-Hant', { numeric: true });
      return 0;
    });
  }

  function getActiveDriveSortMeta() {
    const val = el.driveSortSelect.value;
    const map = {
      'name asc': { col: 'name', dir: 'asc' },
      'name desc': { col: 'name', dir: 'desc' },
      'quotaBytesUsed asc': { col: 'size', dir: 'asc' },
      'quotaBytesUsed desc': { col: 'size', dir: 'desc' },
      'modifiedTime asc': { col: 'date', dir: 'asc' },
      'modifiedTime desc': { col: 'date', dir: 'desc' },
      'unused asc': { col: 'unused', dir: 'asc' },
      'unused desc': { col: 'unused', dir: 'desc' }
    };
    return map[val] || { col: null, dir: null };
  }

  function getActiveGmailSortMeta() {
    const val = el.gmailSortSelect.value;
    const map = {
      subjectAsc: { col: 'subject', dir: 'asc' },
      subjectDesc: { col: 'subject', dir: 'desc' },
      fromAsc: { col: 'from', dir: 'asc' },
      fromDesc: { col: 'from', dir: 'desc' },
      sizeAsc: { col: 'size', dir: 'asc' },
      sizeDesc: { col: 'size', dir: 'desc' },
      dateAsc: { col: 'date', dir: 'asc' },
      dateDesc: { col: 'date', dir: 'desc' }
    };
    return map[val] || { col: null, dir: null };
  }

  function updateSortHeaderUI() {
    const driveMeta = getActiveDriveSortMeta();
    document.querySelectorAll('[data-drive-sort-col]').forEach((btn) => {
      const col = btn.dataset.driveSortCol;
      const isMatch = driveMeta.col === col;
      btn.classList.toggle('is-sorted', isMatch);
      const th = btn.closest('th');
      if (th) {
        th.setAttribute('aria-sort', isMatch ? (driveMeta.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      }
      const icon = btn.querySelector('.sort-icon');
      if (icon) {
        icon.className = isMatch
          ? `ph ${driveMeta.dir === 'asc' ? 'ph-arrow-up' : 'ph-arrow-down'} text-xs sort-icon text-[#3B82F6]`
          : 'ph ph-arrows-down-up text-xs sort-icon';
      }
    });

    const gmailMeta = getActiveGmailSortMeta();
    document.querySelectorAll('[data-gmail-sort-col]').forEach((btn) => {
      const col = btn.dataset.gmailSortCol;
      const isMatch = gmailMeta.col === col;
      btn.classList.toggle('is-sorted', isMatch);
      const th = btn.closest('th');
      if (th) {
        th.setAttribute('aria-sort', isMatch ? (gmailMeta.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      }
      const icon = btn.querySelector('.sort-icon');
      if (icon) {
        icon.className = isMatch
          ? `ph ${gmailMeta.dir === 'asc' ? 'ph-arrow-up' : 'ph-arrow-down'} text-xs sort-icon text-[#3B82F6]`
          : 'ph ph-arrows-down-up text-xs sort-icon';
      }
    });
  }

  function updateGmailSelectionStats() {
    const selected = state.gmail.items.filter((m) => state.gmail.selectedIds.has(m.id));
    const totalBytes = selected.reduce((sum, m) => sum + (Number(m.sizeEstimate) || 0), 0);

    el.gmailTotalCount.textContent = String(state.gmail.items.length);
    el.gmailSelectedCount.textContent = String(selected.length);
    el.gmailSelectedSize.textContent = formatBytes(totalBytes);

    const hasSelection = selected.length > 0;
    const isTrashScope = el.gmailCategoryFilter.value === 'in:trash';
    el.gmailBatchTrashBtn.disabled = !hasSelection || isTrashScope;
    el.gmailBatchDeleteBtn.disabled = !hasSelection;

    el.gmailSelectAllCheckbox.checked = state.gmail.items.length > 0 && selected.length === state.gmail.items.length;
    updateSortHeaderUI();
    renderLiveStorageVisualizer();
  }

  /* ========================================================================
     統一安全確認對話框與批次執行引擎
     ======================================================================== */
  let pendingModalAction = null;

  function openConfirmModal({ title, subtitle, summaryHtml, actionText, isDanger, onConfirm }) {
    pendingModalAction = onConfirm;
    el.confirmModalTitle.textContent = title;
    el.confirmModalSubtitle.textContent = subtitle;
    el.confirmModalBody.innerHTML = summaryHtml;
    el.confirmModalExecuteBtn.textContent = actionText;
    el.confirmModalExecuteBtn.className = isDanger ? 'btn-danger' : 'btn-primary';
    el.confirmModalExecuteBtn.disabled = false;
    el.confirmModalCancelBtn.disabled = false;
    el.confirmProgressWrap.classList.add('hidden');
    el.confirmProgressBar.style.width = '0%';

    el.confirmModalBackdrop.classList.add('is-open');
    el.confirmModalBackdrop.setAttribute('aria-hidden', 'false');
  }

  function closeConfirmModal() {
    pendingModalAction = null;
    el.confirmModalBackdrop.classList.remove('is-open');
    el.confirmModalBackdrop.setAttribute('aria-hidden', 'true');
  }

  function updateModalProgress(done, total, label) {
    el.confirmProgressWrap.classList.remove('hidden');
    el.confirmProgressLabel.textContent = label;
    el.confirmProgressCount.textContent = `${done} / ${total}`;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    el.confirmProgressBar.style.width = `${pct}%`;
  }

  async function executeDriveDeletion(ids, permanent) {
    const idSet = new Set(ids);
    const mergedMap = new Map();
    state.insights.topFiles.forEach((f) => {
      if (idSet.has(f.id)) mergedMap.set(f.id, f);
    });
    state.drive.items.forEach((f) => {
      if (idSet.has(f.id)) mergedMap.set(f.id, f);
    });
    const items = Array.from(mergedMap.values());
    if (items.length === 0) return;

    const totalBytes = items.reduce((sum, item) => sum + Number(item.quotaBytesUsed || 0), 0);
    const actionLabel = permanent ? '永久刪除雲端硬碟檔案' : '移至雲端硬碟垃圾桶';

    openConfirmModal({
      title: actionLabel,
      subtitle: permanent ? '永久刪除後將無法從垃圾桶救回' : '檔案將移入垃圾桶，清空垃圾桶後才會完全釋放配額',
      summaryHtml: `
        <p class="text-white font-semibold">即將處理 <span class="font-mono-num">${items.length}</span> 個檔案，合計容量 <span class="font-mono-num text-[#10B981]">${formatBytes(totalBytes)}</span></p>
        <p class="text-xs text-[#A3A3A3]">代表項目：${escapeHtml(items.slice(0, 3).map((i) => i.name).join('、'))}${items.length > 3 ? ' 等項目' : ''}</p>
      `,
      actionText: permanent ? '確認永久刪除' : '確認移至垃圾桶',
      isDanger: permanent,
      onConfirm: async () => {
        let completed = 0;
        let failed = 0;

        if (state.mode === 'demo') {
          for (const item of items) {
            await new Promise((r) => setTimeout(r, 80));
            if (permanent) {
              state.demoStore.driveFiles = state.demoStore.driveFiles.filter((f) => f.id !== item.id);
            } else {
              const target = state.demoStore.driveFiles.find((f) => f.id === item.id);
              if (target) target.trashed = true;
            }
            completed++;
            updateModalProgress(completed, items.length, actionLabel);
          }
        } else {
          for (const item of items) {
            try {
              if (permanent) {
                await googleApiFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(item.id)}`, {
                  method: 'DELETE'
                });
              } else {
                await googleApiFetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(item.id)}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ trashed: true })
                });
              }
            } catch (err) {
              failed++;
              console.error('Drive 刪除失敗', item.id, err);
            }
            completed++;
            updateModalProgress(completed, items.length, actionLabel);
          }
        }

        const removedSet = new Set(ids);
        state.drive.items = state.drive.items.filter((item) => !removedSet.has(item.id));
        ids.forEach((id) => state.drive.selectedIds.delete(id));

        const remainingTop = state.insights.topFiles.filter((f) => !removedSet.has(f.id));
        buildInsightsFromFiles(remainingTop);
        populateDriveFolderFilter();

        closeConfirmModal();
        renderDriveTable();
        await loadStorageQuota();
        renderInsightsDashboard();

        if (failed > 0) {
          showToast(`已完成處理，成功 ${items.length - failed} 筆，失敗 ${failed} 筆（部分共享檔案可能沒有刪除權限）。`, 'warning');
        } else {
          showToast(`已成功${permanent ? '永久刪除' : '移至垃圾桶'} ${items.length} 個雲端硬碟項目（${formatBytes(totalBytes)}）。`, 'success');
        }
      }
    });
  }

  function executeEmptyDriveTrash() {
    if (state.mode === 'guest') {
      showToast('請先登入 Google 帳號或切換至模擬展示模式。', 'warning');
      return;
    }

    const trashBytes = state.quota ? state.quota.usageInDriveTrash : 0;

    openConfirmModal({
      title: '一鍵清空 Google 雲端硬碟垃圾桶',
      subtitle: '此操作會立即永久刪除雲端硬碟垃圾桶內所有項目',
      summaryHtml: `
        <p class="text-white font-semibold">目前垃圾桶佔用空間：<span class="font-mono-num text-[#FCA5A5]">${formatBytes(trashBytes)}</span></p>
        <p class="text-xs text-[#A3A3A3]">清空後將立即釋放上述配額，且無法恢復任何垃圾桶檔案。</p>
      `,
      actionText: '確認清空垃圾桶',
      isDanger: true,
      onConfirm: async () => {
        updateModalProgress(1, 2, '正在清空雲端硬碟垃圾桶');
        if (state.mode === 'demo') {
          await new Promise((r) => setTimeout(r, 300));
          state.demoStore.driveFiles = state.demoStore.driveFiles.filter((f) => !f.trashed);
        } else {
          await googleApiFetch(`${DRIVE_API_BASE}/files/trash`, { method: 'DELETE' });
        }
        updateModalProgress(2, 2, '已完成清空');

        if (el.driveScopeFilter.value === 'trash') {
          state.drive.items = [];
          state.drive.selectedIds.clear();
        }

        closeConfirmModal();
        renderDriveTable();
        await loadStorageQuota();
        renderInsightsDashboard();
        showToast('已徹底清空 Google 雲端硬碟垃圾桶並更新空間統計。', 'success');
      }
    });
  }

  async function executeGmailDeletion(ids, permanent) {
    const items = state.gmail.items.filter((m) => ids.includes(m.id));
    if (items.length === 0) return;

    const totalBytes = items.reduce((sum, m) => sum + Number(m.sizeEstimate || 0), 0);
    const actionLabel = permanent ? '永久刪除 Gmail 信件' : '移至 Gmail 垃圾桶';

    openConfirmModal({
      title: actionLabel,
      subtitle: permanent ? '透過 batchDelete 徹底移除郵件與附件，無法復原' : '信件將移至 Gmail 垃圾桶（30 天後系統自動清除）',
      summaryHtml: `
        <p class="text-white font-semibold">即將處理 <span class="font-mono-num">${items.length}</span> 封信件，預估釋放 <span class="font-mono-num text-[#10B981]">${formatBytes(totalBytes)}</span></p>
        <p class="text-xs text-[#A3A3A3]">代表主旨：${escapeHtml(items.slice(0, 2).map((m) => m.subject).join('、'))}${items.length > 2 ? ' 等信件' : ''}</p>
      `,
      actionText: permanent ? '確認永久刪除信件' : '確認移至垃圾桶',
      isDanger: permanent,
      onConfirm: async () => {
        let failed = 0;

        if (state.mode === 'demo') {
          let done = 0;
          for (const msg of items) {
            await new Promise((r) => setTimeout(r, 70));
            if (permanent) {
              state.demoStore.gmailMessages = state.demoStore.gmailMessages.filter((m) => m.id !== msg.id);
            } else {
              const found = state.demoStore.gmailMessages.find((m) => m.id === msg.id);
              if (found) found.inTrash = true;
            }
            done++;
            updateModalProgress(done, items.length, actionLabel);
          }
        } else if (permanent) {
          updateModalProgress(1, 2, '正在執行 Gmail batchDelete');
          await googleApiFetch(`${GMAIL_API_BASE}/messages/batchDelete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
          });
          updateModalProgress(2, 2, '已完成永久刪除');
        } else {
          let done = 0;
          for (const id of ids) {
            try {
              await googleApiFetch(`${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}/trash`, {
                method: 'POST'
              });
            } catch (err) {
              failed++;
              console.error('Gmail trash 失敗', id, err);
            }
            done++;
            updateModalProgress(done, ids.length, actionLabel);
          }
        }

        const removedSet = new Set(ids);
        state.gmail.items = state.gmail.items.filter((m) => !removedSet.has(m.id));
        ids.forEach((id) => state.gmail.selectedIds.delete(id));

        closeConfirmModal();
        renderGmailTable();
        await loadStorageQuota();

        if (failed > 0) {
          showToast(`已完成處理，成功 ${items.length - failed} 封，失敗 ${failed} 封。`, 'warning');
        } else {
          showToast(`已成功${permanent ? '永久刪除' : '移至垃圾桶'} ${items.length} 封 Gmail 信件（${formatBytes(totalBytes)}）。`, 'success');
        }
      }
    });
  }

  /* ========================================================================
     隱私與說明彈窗
     ======================================================================== */
  function openInfoModal(type) {
    if (type === 'privacy') {
      el.infoModalTitle.textContent = '隱私權處理原則';
      el.infoModalContent.innerHTML = `
        <p>1. 本網頁為純靜態本地端網頁介面，所有程式碼皆直接在您的瀏覽器中運行。</p>
        <p>2. 您的 Google OAuth 2.0 Client ID 僅儲存在您本機瀏覽器的 <code class="font-mono text-white">localStorage</code>，Access Token 僅暫存於目前分頁記憶體中，關閉分頁即自動銷毀。</p>
        <p>3. 檔案清單與信件中繼資料僅從 Google 官方 API 直接傳送至您的電腦，不會經過任何外部中繼伺服器。</p>
      `;
    } else {
      el.infoModalTitle.textContent = '安全刪除條款與操作提醒';
      el.infoModalContent.innerHTML = `
        <p>1. 選擇「移至垃圾桶」時，項目仍會暫時保留於 Google 雲端硬碟或 Gmail 垃圾桶中，這期間仍會計入總容量，直至垃圾桶被清空為止。</p>
        <p>2. 選擇「永久刪除」或「一鍵清空垃圾桶」會直接呼叫 Google 官方刪除端點，執行完成後無法復原。</p>
        <p>3. 建議先使用篩選條件確認檔案天數與主旨無誤後，再進行大量批次清除作業。</p>
      `;
    }

    el.infoModalBackdrop.classList.add('is-open');
    el.infoModalBackdrop.setAttribute('aria-hidden', 'false');
  }

  function closeInfoModal() {
    el.infoModalBackdrop.classList.remove('is-open');
    el.infoModalBackdrop.setAttribute('aria-hidden', 'true');
  }

  /* ========================================================================
     IntersectionObserver：區塊進場與 Tagline 逐詞顯現
     ======================================================================== */
  function setupScrollEffects() {
    const wordContainer = document.getElementById('taglineWordContainer');
    if (wordContainer) {
      const rawText = wordContainer.textContent.trim();
      const tokens = rawText.split(/(\s+|，|。)/).filter((t) => t.length > 0);
      wordContainer.innerHTML = tokens.map((token) => {
        if (/^\s+$/.test(token)) return ' ';
        return `<span class="tagline-word">${escapeHtml(token)}</span>`;
      }).join('');
    }

    const revealSections = document.querySelectorAll('.reveal-section');
    const sectionObserver = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          if (entry.target.id === 'taglineRevealSection') {
            const words = entry.target.querySelectorAll('.tagline-word');
            words.forEach((word, idx) => {
              setTimeout(() => {
                word.classList.add('is-active');
              }, idx * 55);
            });
          }
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.2 });

    revealSections.forEach((sec) => sectionObserver.observe(sec));
  }

  /* ========================================================================
     事件綁定與初始化
     ======================================================================== */
  function bindEvents() {
    // 協議檢查
    if (window.location.protocol === 'file:') {
      el.protocolWarningBanner.classList.remove('hidden');
    }

    // 導覽切換
    document.querySelectorAll('[data-nav-target]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.navTarget));
    });

    el.mobileMenuToggleBtn.addEventListener('click', openMobileDrawer);
    el.mobileMenuCloseBtn.addEventListener('click', closeMobileDrawer);
    el.globalToastCloseBtn.addEventListener('click', () => el.globalToastContainer.classList.add('hidden'));

    // 認證與模式切換
    el.heroLoginBtn.addEventListener('click', startGoogleLogin);
    el.navAuthActionBtn.addEventListener('click', startGoogleLogin);
    el.mobileAuthActionBtn.addEventListener('click', () => {
      closeMobileDrawer();
      startGoogleLogin();
    });
    el.guideLoginNowBtn.addEventListener('click', startGoogleLogin);
    el.heroDemoBtn.addEventListener('click', activateDemoMode);
    el.signOutBtn.addEventListener('click', signOut);
    el.refreshQuotaBtn.addEventListener('click', () => {
      withButtonBusy(el.refreshQuotaBtn, '正在更新容量...', async () => {
        await Promise.all([loadStorageQuota(), loadDriveInsights()]);
        showToast('已完成更新帳號空間統計與大資料層掃描。', 'success');
      });
    });
    el.refreshInsightsBtn.addEventListener('click', () => {
      withButtonBusy(el.refreshInsightsBtn, '正在掃描資料層...', async () => {
        await loadDriveInsights();
        showToast('已完成重新掃描大資料層與長期未使用檔案排行。', 'success');
      });
    });
    el.autoSelectTargetBtn.addEventListener('click', () => {
      withButtonBusy(el.autoSelectTargetBtn, '正在計算挑檔...', autoSelectToMeetTarget);
    });

    // 12/24 一般使用者 20% 預留空間與置頂動態儀表板連動控制
    function syncTargetPlanControls() {
      el.customTargetGbWrap.classList.toggle('hidden', el.targetPlanSelect.value !== 'custom');
      if (['15', 'current', '100'].includes(el.targetPlanSelect.value)) {
        el.liveTargetModeSelect.value = el.targetPlanSelect.value;
      }
      el.liveReserveSlider.value = el.reservePercentSelect.value;
      renderTarget1224Calculator();
      renderLiveStorageVisualizer();
    }
    el.targetPlanSelect.addEventListener('change', syncTargetPlanControls);
    el.reservePercentSelect.addEventListener('change', syncTargetPlanControls);
    el.customTargetGbInput.addEventListener('input', syncTargetPlanControls);

    el.liveTargetModeSelect.addEventListener('change', () => {
      el.targetPlanSelect.value = el.liveTargetModeSelect.value;
      el.customTargetGbWrap.classList.add('hidden');
      renderTarget1224Calculator();
      renderLiveStorageVisualizer();
    });
    el.liveReserveSlider.addEventListener('input', () => {
      const val = el.liveReserveSlider.value;
      if (['20', '25', '30'].includes(val)) {
        el.reservePercentSelect.value = val;
      }
      renderTarget1224Calculator();
      renderLiveStorageVisualizer();
    });

    // 三大優先清理方案按鈕
    document.querySelectorAll('[data-apply-plan]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.mode === 'guest') {
          activateDemoMode();
        }
        const plan = btn.dataset.applyPlan;
        if (plan === 'planA') {
          el.driveSizeFilter.value = '100';
          el.driveDaysFilter.value = '365';
          el.driveScopeFilter.value = 'active';
          el.driveFolderFilter.value = 'all';
          el.driveSortSelect.value = 'recommend desc';
          syncCustomFilterVisibility();
          switchTab('drive');
          loadDriveFiles(false);
          if (state.quota && state.quota.usageInDriveTrash > 0) {
            showToast(`方案 A 提示：您尚有 ${formatBytes(state.quota.usageInDriveTrash)} 在垃圾桶，可點擊上方「一鍵清空雲端硬碟垃圾桶」直接釋放。`, 'info');
          }
        } else if (plan === 'planB') {
          el.driveSizeFilter.value = '50';
          el.driveDaysFilter.value = '180';
          el.driveScopeFilter.value = 'active';
          el.driveFolderFilter.value = 'all';
          el.driveSortSelect.value = 'recommend desc';
          syncCustomFilterVisibility();
          switchTab('drive');
          loadDriveFiles(false);
          showToast('已套用方案 B 篩選超過 180 天且大於 50 MB 的舊檔，清理後可再至「Gmail 清理」篩選大於 5 MB 舊信件。', 'info');
        } else if (plan === 'planC') {
          const topFolder = state.insights.folderStats[0];
          el.driveSizeFilter.value = '0';
          el.driveDaysFilter.value = '0';
          el.driveScopeFilter.value = 'active';
          el.driveFolderFilter.value = topFolder ? topFolder.id : 'all';
          el.driveSortSelect.value = 'quotaBytesUsed desc';
          syncCustomFilterVisibility();
          switchTab('drive');
          loadDriveFiles(false);
        }
      });
    });

    // 大資料層排行點擊委派
    el.folderRankingList.addEventListener('click', (e) => {
      const viewBtn = e.target.closest('.insight-folder-view-btn');
      if (viewBtn) {
        const folderId = viewBtn.dataset.folderId;
        el.driveSizeFilter.value = '0';
        el.driveDaysFilter.value = '0';
        el.driveScopeFilter.value = 'active';
        el.driveTypeFilter.value = 'all';
        el.driveFolderFilter.value = folderId;
        el.driveSortSelect.value = 'quotaBytesUsed desc';
        syncCustomFilterVisibility();
        switchTab('drive');
        loadDriveFiles(false);
        return;
      }

      const trashFolderBtn = e.target.closest('.insight-folder-trash-btn');
      if (trashFolderBtn) {
        const folderId = trashFolderBtn.dataset.folderId;
        const folder = state.insights.folderStats.find((f) => f.id === folderId);
        if (folder && folder.files.length > 0) {
          executeDriveDeletion(folder.files.map((f) => f.id), false);
        }
      }
    });

    // 長期未使用大檔案推薦點擊委派
    el.unusedLargeFilesList.addEventListener('click', (e) => {
      const trashBtn = e.target.closest('.insight-file-trash-btn');
      if (trashBtn) {
        executeDriveDeletion([trashBtn.dataset.fileId], false);
        return;
      }
      const deleteBtn = e.target.closest('.insight-file-delete-btn');
      if (deleteBtn) {
        executeDriveDeletion([deleteBtn.dataset.fileId], true);
      }
    });

    // Client ID 儲存
    el.quickSaveClientIdBtn.addEventListener('click', () => {
      saveClientId(el.quickClientIdInput.value, el.quickClientIdFeedback);
    });
    el.guideSaveClientIdBtn.addEventListener('click', () => {
      saveClientId(el.guideClientIdInput.value, el.guideClientIdFeedback);
    });

    // 總覽快速清理捷徑
    document.querySelectorAll('[data-quick-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.mode === 'guest') {
          activateDemoMode();
        }
        const action = btn.dataset.quickAction;
        if (action === 'drive-large-100') {
          el.driveSizeFilter.value = '100';
          el.driveDaysFilter.value = '0';
          el.driveScopeFilter.value = 'active';
          el.driveFolderFilter.value = 'all';
          el.driveSortSelect.value = 'quotaBytesUsed desc';
          syncCustomFilterVisibility();
          switchTab('drive');
          loadDriveFiles(false);
        } else if (action === 'drive-old-180') {
          el.driveSizeFilter.value = '0';
          el.driveDaysFilter.value = '180';
          el.driveScopeFilter.value = 'active';
          el.driveFolderFilter.value = 'all';
          el.driveSortSelect.value = 'modifiedTime asc';
          syncCustomFilterVisibility();
          switchTab('drive');
          loadDriveFiles(false);
        } else if (action === 'drive-trash') {
          el.driveSizeFilter.value = '0';
          el.driveDaysFilter.value = '0';
          el.driveScopeFilter.value = 'trash';
          el.driveFolderFilter.value = 'all';
          el.driveSortSelect.value = 'quotaBytesUsed desc';
          syncCustomFilterVisibility();
          switchTab('drive');
          loadDriveFiles(false);
        } else if (action === 'gmail-large-old') {
          el.gmailSizeFilter.value = '5';
          el.gmailDaysFilter.value = '180';
          el.gmailCategoryFilter.value = 'all';
          syncCustomFilterVisibility();
          switchTab('gmail');
          loadGmailMessages(false);
        }
      });
    });

    // 自訂篩選欄位顯隱同步
    function syncCustomFilterVisibility() {
      el.driveCustomSizeWrap.classList.toggle('hidden', el.driveSizeFilter.value !== 'custom');
      el.driveCustomDaysWrap.classList.toggle('hidden', el.driveDaysFilter.value !== 'custom');
      el.gmailCustomSizeWrap.classList.toggle('hidden', el.gmailSizeFilter.value !== 'custom');
      el.gmailCustomDaysWrap.classList.toggle('hidden', el.gmailDaysFilter.value !== 'custom');
      buildGmailSearchQuery();
    }

    [el.driveSizeFilter, el.driveDaysFilter, el.gmailSizeFilter, el.gmailDaysFilter, el.gmailCategoryFilter].forEach((sel) => {
      sel.addEventListener('change', syncCustomFilterVisibility);
    });
    [el.gmailCustomSizeInput, el.gmailCustomDaysInput, el.gmailSearchInput].forEach((inp) => {
      inp.addEventListener('input', buildGmailSearchQuery);
    });

    // Drive 查詢與事件委派
    el.driveApplyFilterBtn.addEventListener('click', () => {
      if (state.mode === 'guest') {
        showToast('請先於「使用量總覽」登入 Google 帳號，或啟動模擬展示模式。', 'warning');
        return;
      }
      withButtonBusy(el.driveApplyFilterBtn, '查詢中...', async () => {
        await loadDriveFiles(false);
        showToast(`查詢完成，共找到 ${state.drive.items.length} 個符合條件的項目。`, 'info');
      });
    });
    el.driveFolderFilter.addEventListener('change', () => loadDriveFiles(false));
    el.driveSortSelect.addEventListener('change', () => {
      updateSortHeaderUI();
      if (state.drive.items.length > 0) {
        sortDriveItemsList(state.drive.items, el.driveSortSelect.value);
        renderDriveTable();
      }
    });

    document.querySelectorAll('[data-drive-sort-col]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const col = btn.dataset.driveSortCol;
        const current = getActiveDriveSortMeta();
        let nextDir;
        if (current.col === col) {
          nextDir = current.dir === 'asc' ? 'desc' : 'asc';
        } else {
          nextDir = (col === 'name' || col === 'date') ? 'asc' : 'desc';
        }

        const valueMap = {
          name: { asc: 'name asc', desc: 'name desc' },
          size: { asc: 'quotaBytesUsed asc', desc: 'quotaBytesUsed desc' },
          date: { asc: 'modifiedTime asc', desc: 'modifiedTime desc' },
          unused: { asc: 'unused asc', desc: 'unused desc' }
        };
        if (valueMap[col] && valueMap[col][nextDir]) {
          el.driveSortSelect.value = valueMap[col][nextDir];
          updateSortHeaderUI();
          if (state.drive.items.length > 0) {
            sortDriveItemsList(state.drive.items, el.driveSortSelect.value);
            renderDriveTable();
          }
        }
      });
    });

    el.driveLoadMoreBtn.addEventListener('click', () => {
      withButtonBusy(el.driveLoadMoreBtn, '載入中...', () => loadDriveFiles(true));
    });
    el.driveEmptyTrashBtn.addEventListener('click', executeEmptyDriveTrash);
    el.scanDuplicatesBtn.addEventListener('click', () => {
      withButtonBusy(el.scanDuplicatesBtn, '掃描重複中...', scanDuplicateBackups);
    });
    el.selectOldDuplicatesBtn.addEventListener('click', selectOldDuplicates);
    el.driveExitFolderBtn.addEventListener('click', exitDriveFolder);

    el.driveSelectAllCheckbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        state.drive.items.forEach((item) => state.drive.selectedIds.add(item.id));
      } else {
        state.drive.selectedIds.clear();
      }
      renderDriveTable();
    });

    el.driveTableBody.addEventListener('change', (e) => {
      if (e.target.classList.contains('drive-row-checkbox')) {
        const id = e.target.dataset.id;
        if (e.target.checked) state.drive.selectedIds.add(id);
        else state.drive.selectedIds.delete(id);
        renderDriveTable();
      }
    });

    el.driveTableBody.addEventListener('click', (e) => {
      const inspectBtn = e.target.closest('.drive-inspect-btn');
      if (inspectBtn) {
        openFilePreviewModal(inspectBtn.dataset.id);
        return;
      }
      const enterFolderBtn = e.target.closest('.drive-enter-folder-btn');
      if (enterFolderBtn) {
        enterDriveFolder(enterFolderBtn.dataset.folderId, enterFolderBtn.dataset.folderName);
        return;
      }
      const trashBtn = e.target.closest('.drive-single-trash-btn');
      if (trashBtn) {
        executeDriveDeletion([trashBtn.dataset.id], false);
        return;
      }
      const delBtn = e.target.closest('.drive-single-delete-btn');
      if (delBtn) {
        executeDriveDeletion([delBtn.dataset.id], true);
      }
    });

    // 檔案預覽與歷史版本對話框事件
    el.previewModalCloseBtn.addEventListener('click', closeFilePreviewModal);
    el.filePreviewModalBackdrop.addEventListener('click', (e) => {
      if (e.target === el.filePreviewModalBackdrop) closeFilePreviewModal();
    });
    el.previewEnterFolderBtn.addEventListener('click', () => {
      const fid = el.previewEnterFolderBtn.dataset.folderId;
      const fname = el.previewEnterFolderBtn.dataset.folderName;
      closeFilePreviewModal();
      enterDriveFolder(fid, fname);
    });
    el.previewRebuildCleanBtn.addEventListener('click', rebuildCleanFileWorkflow);
    el.previewCleanOldRevisionsBtn.addEventListener('click', cleanOldRevisions);
    el.previewReauthBtn.addEventListener('click', () => startGoogleLogin(true));
    el.previewTrashFileBtn.addEventListener('click', () => {
      const id = state.preview.file && state.preview.file.id;
      if (!id) return;
      closeFilePreviewModal();
      executeDriveDeletion([id], false);
    });
    el.previewDeleteFileBtn.addEventListener('click', () => {
      const id = state.preview.file && state.preview.file.id;
      if (!id) return;
      closeFilePreviewModal();
      executeDriveDeletion([id], true);
    });

    el.driveBatchTrashBtn.addEventListener('click', () => {
      executeDriveDeletion(Array.from(state.drive.selectedIds), false);
    });
    el.driveBatchDeleteBtn.addEventListener('click', () => {
      executeDriveDeletion(Array.from(state.drive.selectedIds), true);
    });

    // Gmail 查詢與事件委派
    el.gmailSubtabCleanerBtn.addEventListener('click', () => switchGmailSubtab('cleaner'));
    el.gmailSubtabSubscriptionsBtn.addEventListener('click', () => switchGmailSubtab('subscriptions'));

    el.gmailViewModeGroupedBtn.addEventListener('click', () => {
      state.gmail.viewMode = 'grouped';
      el.gmailViewModeGroupedBtn.className = 'px-2.5 py-1 rounded-md font-semibold text-white bg-[#272727] border border-[#383838]';
      el.gmailViewModeFlatBtn.className = 'px-2.5 py-1 rounded-md font-semibold text-[#A3A3A3] hover:text-white bg-transparent border-0';
      renderGmailTable();
    });

    el.gmailViewModeFlatBtn.addEventListener('click', () => {
      state.gmail.viewMode = 'flat';
      el.gmailViewModeFlatBtn.className = 'px-2.5 py-1 rounded-md font-semibold text-white bg-[#272727] border border-[#383838]';
      el.gmailViewModeGroupedBtn.className = 'px-2.5 py-1 rounded-md font-semibold text-[#A3A3A3] hover:text-white bg-transparent border-0';
      renderGmailTable();
    });

    el.gmailExpandAllBtn.addEventListener('click', () => {
      state.gmail.collapsedSenders.clear();
      renderGmailTable();
    });

    el.gmailCollapseAllBtn.addEventListener('click', () => {
      const groups = groupGmailBySender(state.gmail.items);
      groups.forEach((g) => state.gmail.collapsedSenders.add(g.key));
      renderGmailTable();
    });

    el.gmailGroupedContainer.addEventListener('click', (e) => {
      // 點擊群組內的單信垃圾桶按鈕
      const singleTrashBtn = e.target.closest('.gmail-single-trash-btn');
      if (singleTrashBtn) {
        e.stopPropagation();
        executeGmailDeletion([singleTrashBtn.dataset.id], false);
        return;
      }
      // 點擊群組內的單信永久刪除按鈕
      const singleDelBtn = e.target.closest('.gmail-single-delete-btn');
      if (singleDelBtn) {
        e.stopPropagation();
        executeGmailDeletion([singleDelBtn.dataset.id], true);
        return;
      }
      // 點擊群組退訂按鈕
      const quickUnsubBtn = e.target.closest('.sub-quick-unsub-btn');
      if (quickUnsubBtn) {
        e.stopPropagation();
        const key = quickUnsubBtn.dataset.senderKey;
        const groups = groupGmailBySender(state.gmail.items);
        const target = groups.find((g) => g.key === key);
        if (target) handleUnsubscribe(target);
        return;
      }
      // 點擊整組移入垃圾桶
      const groupTrashBtn = e.target.closest('.sender-group-trash-btn');
      if (groupTrashBtn) {
        e.stopPropagation();
        const key = groupTrashBtn.dataset.senderKey;
        const groups = groupGmailBySender(state.gmail.items);
        const target = groups.find((g) => g.key === key);
        if (target) executeGmailDeletion(target.messages.map((m) => m.id), false);
        return;
      }
      // 點擊整組永久刪除
      const groupDelBtn = e.target.closest('.sender-group-delete-btn');
      if (groupDelBtn) {
        e.stopPropagation();
        const key = groupDelBtn.dataset.senderKey;
        const groups = groupGmailBySender(state.gmail.items);
        const target = groups.find((g) => g.key === key);
        if (target) executeGmailDeletion(target.messages.map((m) => m.id), true);
        return;
      }
      // 點擊群組全選方塊
      const groupCheckbox = e.target.closest('.sender-group-select-checkbox');
      if (groupCheckbox) {
        e.stopPropagation();
        const key = groupCheckbox.dataset.senderKey;
        const groups = groupGmailBySender(state.gmail.items);
        const target = groups.find((g) => g.key === key);
        if (target) {
          const checked = groupCheckbox.checked;
          target.messages.forEach((m) => {
            if (checked) state.gmail.selectedIds.add(m.id);
            else state.gmail.selectedIds.delete(m.id);
          });
          renderGmailTable();
        }
        return;
      }
      // 點擊單信 checkbox
      const rowCheckbox = e.target.closest('.gmail-row-checkbox');
      if (rowCheckbox) {
        e.stopPropagation();
        const id = rowCheckbox.dataset.id;
        if (rowCheckbox.checked) state.gmail.selectedIds.add(id);
        else state.gmail.selectedIds.delete(id);
        renderGmailTable();
        return;
      }
      // 點擊卡片標頭展開／收合
      const header = e.target.closest('.sender-group-header');
      if (header) {
        const card = header.closest('.sender-group-card');
        if (card) {
          const key = card.dataset.senderKey;
          const isCurrentlyExpanded = card.classList.contains('is-expanded');
          if (isCurrentlyExpanded) {
            state.gmail.collapsedSenders.add(key);
            card.classList.remove('is-expanded');
          } else {
            state.gmail.collapsedSenders.delete(key);
            card.classList.add('is-expanded');
          }
        }
      }
    });

    // 訂閱管理中心事件
    el.subScanBtn.addEventListener('click', () => scanGmailSubscriptions());
    el.subTableBody.addEventListener('click', (e) => {
      const unsubBtn = e.target.closest('.sub-action-unsub-btn');
      if (unsubBtn) {
        const key = unsubBtn.dataset.senderKey;
        const sub = state.gmail.subscriptions.find((s) => s.key === key);
        if (sub) handleUnsubscribe(sub);
        return;
      }

      const searchBtn = e.target.closest('.sub-action-search-btn');
      if (searchBtn) {
        const email = searchBtn.dataset.senderEmail;
        switchGmailSubtab('cleaner');
        el.gmailSearchInput.value = `from:${email}`;
        el.gmailSizeFilter.value = '0';
        el.gmailDaysFilter.value = '0';
        el.gmailCategoryFilter.value = 'all';
        loadGmailMessages(false);
        showToast(`已切換至信件清單並搜尋來自 ${email} 的所有信件。`, 'info');
        return;
      }

      const trashBtn = e.target.closest('.sub-action-trash-btn');
      if (trashBtn) {
        const key = trashBtn.dataset.senderKey;
        cleanupSubscriptionMessages(key, false);
        return;
      }

      const delBtn = e.target.closest('.sub-action-delete-btn');
      if (delBtn) {
        const key = delBtn.dataset.senderKey;
        cleanupSubscriptionMessages(key, true);
        return;
      }
    });

    el.gmailApplyFilterBtn.addEventListener('click', () => {
      if (state.mode === 'guest') {
        showToast('請先於「使用量總覽」登入 Google 帳號，或啟動模擬展示模式。', 'warning');
        return;
      }
      withButtonBusy(el.gmailApplyFilterBtn, '搜尋中...', async () => {
        await loadGmailMessages(false);
        showToast(`搜尋完成，已載入 ${state.gmail.items.length} 封符合條件的信件。`, 'info');
      });
    });
    el.gmailLoadMoreBtn.addEventListener('click', () => {
      withButtonBusy(el.gmailLoadMoreBtn, '載入中...', () => loadGmailMessages(true));
    });
    el.gmailSortSelect.addEventListener('change', () => {
      updateSortHeaderUI();
      if (state.gmail.items.length > 0) {
        sortGmailList(state.gmail.items);
        renderGmailTable();
      }
    });

    document.querySelectorAll('[data-gmail-sort-col]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const col = btn.dataset.gmailSortCol;
        const current = getActiveGmailSortMeta();
        let nextDir;
        if (current.col === col) {
          nextDir = current.dir === 'asc' ? 'desc' : 'asc';
        } else {
          nextDir = col === 'size' ? 'desc' : 'asc';
        }

        const valueMap = {
          subject: { asc: 'subjectAsc', desc: 'subjectDesc' },
          from: { asc: 'fromAsc', desc: 'fromDesc' },
          size: { asc: 'sizeAsc', desc: 'sizeDesc' },
          date: { asc: 'dateAsc', desc: 'dateDesc' }
        };
        if (valueMap[col] && valueMap[col][nextDir]) {
          el.gmailSortSelect.value = valueMap[col][nextDir];
          updateSortHeaderUI();
          if (state.gmail.items.length > 0) {
            sortGmailList(state.gmail.items);
            renderGmailTable();
          }
        }
      });
    });

    el.gmailSelectAllCheckbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        state.gmail.items.forEach((m) => state.gmail.selectedIds.add(m.id));
      } else {
        state.gmail.selectedIds.clear();
      }
      renderGmailTable();
    });

    el.gmailTableBody.addEventListener('change', (e) => {
      if (e.target.classList.contains('gmail-row-checkbox')) {
        const id = e.target.dataset.id;
        if (e.target.checked) state.gmail.selectedIds.add(id);
        else state.gmail.selectedIds.delete(id);
        renderGmailTable();
      }
    });

    el.gmailTableBody.addEventListener('click', (e) => {
      const trashBtn = e.target.closest('.gmail-single-trash-btn');
      if (trashBtn) {
        executeGmailDeletion([trashBtn.dataset.id], false);
        return;
      }
      const delBtn = e.target.closest('.gmail-single-delete-btn');
      if (delBtn) {
        executeGmailDeletion([delBtn.dataset.id], true);
      }
    });

    el.gmailBatchTrashBtn.addEventListener('click', () => {
      executeGmailDeletion(Array.from(state.gmail.selectedIds), false);
    });
    el.gmailBatchDeleteBtn.addEventListener('click', () => {
      executeGmailDeletion(Array.from(state.gmail.selectedIds), true);
    });

    // 確認對話框按鈕
    el.confirmModalCloseBtn.addEventListener('click', closeConfirmModal);
    el.confirmModalCancelBtn.addEventListener('click', closeConfirmModal);
    el.confirmModalExecuteBtn.addEventListener('click', async () => {
      if (!pendingModalAction) return;
      el.confirmModalExecuteBtn.disabled = true;
      el.confirmModalCancelBtn.disabled = true;
      el.confirmModalExecuteBtn.classList.add('is-busy');
      el.confirmModalExecuteBtn.textContent = '正在執行作業...';
      try {
        await pendingModalAction();
      } catch (err) {
        showToast(`執行操作時發生錯誤：${err.message}`, 'error');
        closeConfirmModal();
      } finally {
        el.confirmModalExecuteBtn.classList.remove('is-busy');
      }
    });

    // 複製教學指令／網址按鈕
    document.querySelectorAll('.copy-snippet-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const text = btn.dataset.copyText || '';
        try {
          await navigator.clipboard.writeText(text);
          const original = btn.textContent;
          btn.textContent = '已複製';
          setTimeout(() => {
            btn.textContent = original;
          }, 1600);
        } catch {
          showToast(`請手動複製此內容：${text}`, 'info');
        }
      });
    });

    // 隱私與條款對話框
    el.openPrivacyModalBtn.addEventListener('click', () => openInfoModal('privacy'));
    el.openTermsModalBtn.addEventListener('click', () => openInfoModal('terms'));
    el.infoModalCloseBtn.addEventListener('click', closeInfoModal);
    el.infoModalConfirmBtn.addEventListener('click', closeInfoModal);
  }

  function init() {
    syncClientIdInputs();
    updateAuthUI();
    renderQuotaDashboard();
    renderInsightsDashboard();
    buildGmailSearchQuery();
    updateSortHeaderUI();
    setupScrollEffects();
    bindEvents();
    setupOAuthBackupListeners();
    checkUrlHashToken();
    tryRestoreSessionToken();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
