import { mavic4ProWideAngle } from "./product.js";

export const siteContent = {
  site: {
    brand: "MaxCINE",
    title: "MaxCINE Mavic 4 Pro 增广镜",
    description:
      "MaxCINE Mavic 4 Pro 增广镜，为 DJI Mavic 4 Pro 航拍影像创作设计的专业增广镜系统。",
    canonical: "https://maxcine.cn/",
    favicon: "/assets/logo2.png",
    ogImage: "https://maxcine.cn/assets/product/hero/maxcine-mavic-4-pro-sci-fi.jpg"
  },
  navigation: [
    { label: "首页", href: "/" },
    { label: "产品", href: mavic4ProWideAngle.url },
    { label: "保修查询", href: "/warranty.html" },
    { label: "支持", href: "/support/" }
  ],
  hero: {
    eyebrow: "专业级航拍无人机增广镜",
    title: "视界尽展",
    tagline: "适用于 DJI Mavic 4 Pro",
    body: "",
    primaryAction: { label: "了解产品", href: mavic4ProWideAngle.url },
    secondaryAction: { label: "▶ 观看样片", action: "sample" },
    video: {
      enabled: false,
      duration: "30s",
      purpose: "product-brand-atmosphere",
      desktopSrc: "/assets/video/hero-desktop.mp4",
      mobileSrc: "/assets/video/hero-mobile.mp4",
      posterDesktop: mavic4ProWideAngle.media.heroPosterDesktop,
      posterMobile: mavic4ProWideAngle.media.heroPosterMobile
    }
  },
  supportLinks: [
    {
      title: "保修查询",
      body: "通过序列号查询公开保修状态与设备权益。",
      href: "/warranty.html"
    },
    {
      title: "售后政策",
      body: "查看保修范围、服务流程和用户权益说明。",
      href: "/support/policy.html"
    },
    {
      title: "维修价格",
      body: "查看常见维修项目与服务费用参考。",
      href: "/repair-pricing/"
    },
    {
      title: "下载中心",
      body: "获取与产品相关的配置、校正和服务资料。",
      href: "/downloads/"
    }
  ],
  channels: [
    {
      title: "官方自营渠道",
      items: ["MaxCINE 官方旗舰店", "极致工作室"]
    },
    {
      title: "授权经销商",
      items: [
        "MaxCINE 智选店",
        "CINEWorks",
        "MaxCINE 聚影",
        "臻品工作室",
        "天枢科技淘宝店",
        "新风影像"
      ]
    }
  ],
  brandStatement: {
    eyebrow: "BRAND",
    title: "每一颗像素背后，都是一次精密工程决策。",
    body:
      "MaxCINE 将航拍与电影工业的工程标准凝聚在产品结构、光学表现和现场可靠性之中。V2 官网会以更少的装饰、更清晰的画面语言呈现产品本身。"
  },
  downloads: {
    title: "下载中心",
    description: "下载中心集中展示产品相关资源；资源权限按正式策略开放。",
    resources: [
      {
        title: "Photoshop CameraRaw",
        file: "/downloads/ps/maxcine_ps_v1.zip",
        status: "legacy-resource"
      },
      {
        title: "Lightroom",
        file: "/downloads/ps/maxcine_lr_v1.zip",
        status: "legacy-resource"
      },
      {
        title: "DaVinci DRX",
        file: "/downloads/ps/maxcine_davinci_v1.zip",
        status: "legacy-resource"
      }
    ]
  },
  policy: {
    title: "售后服务政策",
    description: "以下为 V2 官网保留的政策信息，发布前仍需业务与法务复核。",
    sections: [
      {
        title: "保修范围",
        body: [
          "在规定保修期限内，产品在正常使用情况下出现非人为性能故障。",
          "产品未发生擅自拆解、改装或非官方说明书指引操作。",
          "可提供有效购买凭证，且产品序列号清晰完整。"
        ]
      },
      {
        title: "保修期限",
        body: [
          "CG.W101 标准套装、CG.W102 增强套装、CG.W103 创作套装的最终保修期限以 MaxCINE 正式政策为准。",
          "当前页面不新增未确认的保修天数。"
        ]
      },
      {
        title: "不在保修范围",
        body: [
          "人为原因导致的损坏，包括碰撞、跌落、挤压、进水、腐蚀等。",
          "用户自行维修或使用非官方配件造成的损坏。",
          "光学器件表面人为接触、划伤、污染或镀膜损伤。"
        ]
      },
      {
        title: "技术支持",
        body: [
          "用户可通过官网支持入口、授权经销商或 MaxCINE 服务团队获取支持。",
          "涉及客户资料和维修申请的正式提交方式需在后续阶段接入可信后端，不继续使用旧 Formspree 流程。"
        ]
      }
    ]
  },
  repairPricing: {
    title: "维修价格",
    description: "以下为旧官网已有维修价格参考，发布前需要业务复核。",
    groups: [
      {
        title: "Mavic 4 Pro 增广镜",
        items: [
          ["镜头主上模块（L3）", "¥139"],
          ["镜头主上组件外框（L1）", "¥29"],
          ["镜头主上环绕围脖（PLA）（L1）", "¥29"],
          ["镜头主上环绕围脖（PETG-CF）（L1）", "¥59"],
          ["主体框架模块（含光学镜片）（L3）", "¥185"],
          ["镜头主下组件长焦外光学镜片（L2）", "¥45"],
          ["标准版收纳盒（L0）", "¥68"],
          ["增强版收纳盒（L0）", "¥98"],
          ["外置 ND 滤镜组件（L0）", "¥49"],
          ["云台俯仰轴配重块（L0）", "¥199"]
        ]
      },
      {
        title: "服务费用",
        items: [
          ["基础排查费（换货、整体替换）（L0）", "免费"],
          ["一级检测费（L1）", "¥80"],
          ["二级维修费（L2）", "¥100"],
          ["三级维修费（L3）", "¥120"]
        ]
      }
    ],
    note:
      "实际价格根据设备情况可能调整，具体以 MaxCINE 服务中心最终报价为准。"
  },
  legacyPages: {
    booking: {
      title: "预约页面已归档",
      body:
        "V2 当前不做预售预约和商城流程。旧 Formspree 预约表单已停用，后续如需恢复必须接入可信后端。"
    },
    activate: {
      title: "激活流程待重构",
      body:
        "旧版前端模拟激活和静态 JSON 校验不会带入 V2。正式激活流程需要后续以后端接口实现。"
    }
  }
};

export { mavic4ProWideAngle };
