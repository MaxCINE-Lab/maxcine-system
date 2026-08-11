/* eslint-disable react-hooks/exhaustive-deps */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { SessionUser } from "@maxcine/shared";
import { api, ApiClientError } from "./api";
import { GsxPortal } from "./GsxPortal";
import { AccountMenu, employeeNumberForUser, SystemNavigation } from "./systemNavigation";
import { CameraPhotoButton } from "./CameraPhotoButton";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || "/api";

type Notice = { tone: "error" | "success"; text: string } | null;
type CaseRow = {
  id: string;
  caseNo: string;
  subject: string;
  productName: string | null;
  status: string;
  workflowStage: string;
  createdAt: string;
};
type CaseDetail = {
  case: {
    id: string;
    caseNo: string;
    dealerName: string;
    storeName: string | null;
    orderId: string | null;
    productName: string | null;
    serialNumber: string | null;
    subject: string;
    description: string;
    status: string;
    workflowStage: string;
    serviceCenterName: string | null;
    assignedAt: string | null;
    createdAt: string;
  };
  assessments: Array<{
    result: string;
    details: string;
    actorName: string;
    assessedAt: string;
  }>;
  recommendations: Array<{
    recommendation: string;
    details: string;
    actorName: string;
    recommendedAt: string;
  }>;
};
type CaseRowV2 = CaseRow & {
  serviceStage: string;
  serialNumber: string | null;
  updatedAt: string;
};
type FaultChainDraft = {
  faultPart: string;
  damageType: string;
  causeType: string;
  derivedSymptoms: string[];
  evidence: string;
  relatedPhotoIds: string[];
  severity: string;
  repairability: string;
  recommendedAction: string;
  engineerNote: string;
};
type RepairMaterial = {
  id: string;
  materialCode: string | null;
  materialName: string;
  applicableModels: string;
  outOfWarrantyPriceCents: number | null;
  priceStatus: string;
  outOfWarrantyServiceFeeCents: number | null;
  serviceFeeStatus: string;
  serviceFeeRuleJson: string;
  calculatedServiceFeeCents: number | null;
  calculatedServiceFeeStatus: string;
  warrantyPolicy: string;
  warrantyDays: number | null;
  sourceNote: string;
  compatibilityStatus: string;
  compatibilityWarning: string;
  dataQualityStatus: string;
  issuesJson: string;
};
type SelectedMaterial = {
  material: RepairMaterial;
  quantity: string;
  handlingMethod: string;
  useNew: boolean;
  reuseExisting: boolean;
  repairOnly: boolean;
  recommendCharge: boolean;
  compatibilityOverrideReason: string;
  engineerNote: string;
};
type InspectionRow = {
  id: string;
  version: number;
  faultReproduced: string;
  reproductionStatus: string;
  testResult: string;
  conclusion: string;
  faultCause: string;
  affectedParts: string;
  suggestedAction: string;
  suggestedParts: string;
  recommendWarranty: number;
  recommendCharge: number;
  engineerNote: string;
  difficulty: string;
  estimatedDays: string;
  accidentalDamage: number;
  accidentalDamageType: string;
  accidentalDamageNote: string;
  status: string;
  submittedByName: string;
  submittedAt: string;
  reviewNote: string;
  materialSuggestedTotalCents: number | null;
};
type CaseDetailV2 = {
  case: CaseDetail["case"] & {
    assetId: string | null;
    serviceStage: string;
    caseType: string;
    productVersion: string | null;
    materialCode: string | null;
    contactName: string | null;
    contactPhone: string | null;
    contactEmail: string;
    contactAddress: string;
    inboundCarrier: string;
    inboundTrackingNumber: string;
    inboundNote: string;
    adminReviewNote: string;
    finalDecision: string;
    updatedAt: string;
  };
  attachments: Array<{
    id: string;
    category: string;
    photoSlot: string;
    dataUrl: string;
    contentType: string;
    originalFilename: string;
    uploadedByName: string;
    createdAt: string;
  }>;
  receipts: Array<{
    receivedItemsJson: string;
    packagingIntact: number;
    packagingNote: string;
    itemsMatch: number;
    missingItemsNote: string;
    receiptNote: string;
    receivedByName: string;
    receivedAt: string;
  }>;
  inspections: InspectionRow[];
  faultChains: Array<
    FaultChainDraft & {
      id: string;
      inspectionId: string;
      chainIndex: number;
      derivedSymptomsJson: string;
      relatedPhotoIdsJson: string;
    }
  >;
  inspectionMaterials: Array<{
    id: string;
    inspectionId: string;
    materialId: string;
    materialCode: string;
    materialName: string;
    quantity: number;
    handlingMethod: string;
    unitPriceCents: number | null;
    serviceFeeCents: number | null;
    suggestedTotalCents: number | null;
    priceStatus: string;
    serviceFeeStatus: string;
    compatibilityStatus: string;
    compatibilityWarning: string;
    compatibilityOverrideReason: string;
    engineerNote: string;
  }>;
  timeline: Array<{
    eventType: string;
    title: string;
    description: string;
    actorName: string | null;
    createdAt: string;
  }>;
};

const serviceStageName: Record<string, string> = {
  PENDING_ADMIN_REVIEW: "待管理员审核",
  NEEDS_MORE_INFO: "已退回补充",
  WAITING_CUSTOMER_SHIPMENT: "待客户寄修",
  WAITING_SERVICE_CENTER_RECEIPT: "待收货",
  WAITING_INSPECTION: "待检测",
  INSPECTION_IN_PROGRESS: "检测中",
  PENDING_ADMIN_INSPECTION_REVIEW: "已提交定损",
  INSPECTION_RETURNED: "检测结果退回",
  PENDING_QUOTE: "已提交定损",
  WAITING_CUSTOMER_CONFIRMATION: "等待客户确认",
  READY_FOR_PROCESSING: "待处理",
  WAITING_PAYMENT_CONFIRMATION: "等待确认收款",
  WAITING_REPAIR_SHIPMENT: "待维修及发货",
  RETURN_SHIPPED: "售后已发货",
  CLOSED: "已关闭",
};
const receivedItemOptions = [
  "产品主体",
  "全套包装",
  "收纳盒",
  "平衡模块",
  "其他非官方附件",
];
const facePhotos = [
  ["product_front", "正面"],
  ["product_back", "背面"],
  ["product_left", "左侧"],
  ["product_right", "右侧"],
  ["product_top", "顶部"],
  ["product_bottom", "底部"],
] as const;
const accidentalDamageTypes = [
  "跌落或碰撞",
  "挤压变形",
  "进水或受潮",
  "非正常拆装",
  "胶水或非官方维修痕迹",
  "严重划伤",
  "部件缺失",
  "其他",
];
const actionOptions = [
  "无故障",
  "使用指导",
  "重新安装",
  "清洁处理",
  "维修",
  "更换部件",
  "整机更换建议",
  "拒绝保修建议",
  "单独销售部件",
  "无法维修",
  "其他",
];
const handlingOptions = [
  "更换",
  "维修",
  "重新粘合",
  "重新安装",
  "清洁",
  "调整",
  "利旧",
  "补发",
  "单独销售",
  "整体更换",
  "其他",
];
const date = (v?: string | null) =>
  v
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
        hour12: false,
      }).format(new Date(`${v.replace(" ", "T")}Z`))
    : "—";
const money = (value: number | null | undefined) =>
  typeof value === "number"
    ? `¥${(value / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2 })}`
    : "需确认";
const errorText = (error: unknown) =>
  error instanceof ApiClientError ? error.message : "操作未完成，请稍后重试。";

function Button({
  children,
  onClick,
  href,
  secondary,
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  secondary?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  const cls = `button ${secondary ? "button--secondary" : ""}`;
  return href ? (
    <a className={cls} href={href}>
      {children}
    </a>
  ) : (
    <button type={type} className={cls} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function Shell({
  user,
  route,
  children,
}: {
  user: SessionUser;
  route: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const signOut = async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      location.hash = "#/login";
    }
  };
  return (
    <div className="system">
      <header className="system-top">
        <img
          className="system-light-logo"
          src="/assets/maxcine-logo-on-light.png"
          alt="MaxCINE"
        />
        <button
          className="menu-toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          菜单
        </button>
        <a
          className="global-search"
          href="#/system/service-center/assets"
          aria-label="打开 SN 查询"
        >
          搜索 SN
        </a>
        <a
          className="top-notifications"
          href="#/system/service-center"
          aria-label="查看工单"
        >
          工单
        </a>
        <AccountMenu user={user} logout={() => void signOut()} />
      </header>
      <aside className={`system-nav ${open ? "is-open" : ""}`}>
        <img
          className="system-dark-logo"
          src="/assets/maxcine-logo-on-dark.png"
          alt="MaxCINE"
        />
        <SystemNavigation
          user={user}
          route={route}
          onNavigate={() => setOpen(false)}
        />
      </aside>
      <main className="system-main">{children}</main>
    </div>
  );
}
function Header({ title, text }: { title: string; text: string }) {
  return (
    <header className="page-title">
      <span className="eyebrow">MAXCINE / 工程师</span>
      <h1>{title}</h1>
      <p>{text}</p>
    </header>
  );
}
function toggleValue(
  values: string[],
  value: string,
  checked: boolean,
): string[] {
  return checked
    ? Array.from(new Set([...values, value]))
    : values.filter((item) => item !== value);
}
function CaseListV2({ user, route }: { user: SessionUser; route: string }) {
  const [tab, setTab] = useState(
    new URLSearchParams(route.split("?")[1] ?? "").get("stage") ??
      "WAITING_SERVICE_CENTER_RECEIPT",
  );
  const [rows, setRows] = useState<CaseRowV2[] | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  useEffect(() => {
    api<{ cases: CaseRowV2[] }>("/after-sales?limit=100")
      .then((data) => setRows(data.cases))
      .catch((error) => setNotice({ tone: "error", text: errorText(error) }));
  }, []);
  const filtered =
    rows?.filter((item) => tab === "all" || item.serviceStage === tab || (tab === "PENDING_QUOTE" && item.serviceStage === "PENDING_ADMIN_INSPECTION_REVIEW")) ?? [];
  return (
    <Shell user={user} route={route}>
      <Header
        title="服务中心工单"
        text="只显示分配给本服务中心或由你提交的售后工单。"
      />
      {notice && <div className="notice notice--error">{notice.text}</div>}
      <section className="toolbar">
        <a className="button" href="#/system/after-sales/new">
          代客户提交工单
        </a>
      </section>
      <div className="filter-row">
        {[
          ["WAITING_SERVICE_CENTER_RECEIPT", "待收货"],
          ["WAITING_INSPECTION", "待检测"],
          ["INSPECTION_IN_PROGRESS", "检测中"],
          ["PENDING_QUOTE", "已提交定损"],
          ["all", "全部"],
        ].map(([value, label]) => (
          <button
            className={`filter ${tab === value ? "active" : ""}`}
            key={value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {!rows ? (
        <p>正在加载…</p>
      ) : filtered.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>工单编号</th>
                <th>产品 / SN</th>
                <th>处理阶段</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id}>
                  <td>{item.caseNo}</td>
                  <td>
                    {item.productName || "—"} / {item.serialNumber || "—"}
                  </td>
                  <td>
                    <span className="status">
                      {serviceStageName[item.serviceStage] ?? item.serviceStage}
                    </span>
                  </td>
                  <td>{date(item.createdAt)}</td>
                  <td>
                    <a href={`#/system/service-center/cases/${item.id}`}>
                      处理
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <h2>暂无工单。</h2>
        </div>
      )}
    </Shell>
  );
}

function MaterialSelector({
  assetId,
  selected,
  onChange,
  notice,
}: {
  assetId: string | null;
  selected: SelectedMaterial[];
  onChange: (rows: SelectedMaterial[]) => void;
  notice: (value: Notice) => void;
}) {
  const [rows, setRows] = useState<RepairMaterial[]>([]);
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const load = () =>
    api<{ materials: RepairMaterial[] }>(
      `/repair-materials?assetId=${encodeURIComponent(assetId ?? "")}&q=${encodeURIComponent(q)}&showAll=${showAll}`,
    )
      .then((data) => setRows(data.materials))
      .catch((error) => notice({ tone: "error", text: errorText(error) }));
  useEffect(() => {
    void load();
  }, [assetId, q, showAll]);
  const add = (material: RepairMaterial) => {
    if (selected.some((item) => item.material.id === material.id)) return;
    onChange([
      ...selected,
      {
        material,
        quantity: "1",
        handlingMethod: "更换",
        useNew: true,
        reuseExisting: false,
        repairOnly: false,
        recommendCharge: true,
        compatibilityOverrideReason: "",
        engineerNote: "",
      },
    ]);
  };
  const update = (index: number, patch: Partial<SelectedMaterial>) =>
    onChange(
      selected.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  const lineTotal = (item: SelectedMaterial) => {
    const price = item.material.outOfWarrantyPriceCents;
    const fee = item.material.calculatedServiceFeeCents;
    if (price === null || fee === null) return null;
    return Number(item.quantity || 0) * price + fee;
  };
  return (
    <section>
      <h3>建议维修物料</h3>
      <div className="toolbar">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="搜索料号、名称或关键词"
        />
        <label>
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => setShowAll(event.target.checked)}
          />{" "}
          显示全部物料
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>选择</th>
              <th>料号</th>
              <th>物料名称</th>
              <th>适用型号</th>
              <th>保外价格</th>
              <th>服务费</th>
              <th>保修规则</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr key={item.id}>
                <td>
                  <Button
                    secondary
                    disabled={selected.some(
                      (row) => row.material.id === item.id,
                    )}
                    onClick={() => add(item)}
                  >
                    选择
                  </Button>
                </td>
                <td>{item.materialCode || "缺料号"}</td>
                <td>
                  {item.materialName}
                  <br />
                  {item.compatibilityWarning && (
                    <small className="hint">{item.compatibilityWarning}</small>
                  )}
                </td>
                <td>{item.applicableModels || "需确认"}</td>
                <td>
                  {money(item.outOfWarrantyPriceCents)}
                  <br />
                  <small>{item.priceStatus}</small>
                </td>
                <td>
                  {money(item.calculatedServiceFeeCents)}
                  <br />
                  <small>{item.calculatedServiceFeeStatus}</small>
                </td>
                <td>
                  {item.warrantyPolicy ||
                    (item.warrantyDays ? `${item.warrantyDays}天` : "需确认")}
                </td>
                <td>{item.sourceNote || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>已选物料</th>
                <th>数量</th>
                <th>处理方式</th>
                <th>选项</th>
                <th>参考金额</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {selected.map((item, index) => (
                <tr key={item.material.id}>
                  <td>
                    {item.material.materialCode || "缺料号"}
                    <br />
                    {item.material.materialName}
                    {item.material.compatibilityStatus === "not_applicable" && (
                      <label>
                        选择原因
                        <input
                          value={item.compatibilityOverrideReason}
                          onChange={(event) =>
                            update(index, {
                              compatibilityOverrideReason: event.target.value,
                            })
                          }
                          placeholder="不适配物料必须填写原因"
                        />
                      </label>
                    )}
                  </td>
                  <td>
                    <input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(event) =>
                        update(index, { quantity: event.target.value })
                      }
                    />
                  </td>
                  <td>
                    <select
                      value={item.handlingMethod}
                      onChange={(event) =>
                        update(index, { handlingMethod: event.target.value })
                      }
                    >
                      {handlingOptions.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <label>
                      <input
                        type="checkbox"
                        checked={item.useNew}
                        onChange={(event) =>
                          update(index, { useNew: event.target.checked })
                        }
                      />{" "}
                      使用新件
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={item.reuseExisting}
                        onChange={(event) =>
                          update(index, { reuseExisting: event.target.checked })
                        }
                      />{" "}
                      利旧
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={item.repairOnly}
                        onChange={(event) =>
                          update(index, { repairOnly: event.target.checked })
                        }
                      />{" "}
                      仅维修
                    </label>

                  </td>
                  <td>{money(lineTotal(item))}</td>
                  <td>
                    <Button
                      secondary
                      onClick={() =>
                        onChange(selected.filter((_, i) => i !== index))
                      }
                    >
                      移除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CasePageV2({
  user,
  route,
  id,
}: {
  user: SessionUser;
  route: string;
  id: string;
}) {
  const [data, setData] = useState<CaseDetailV2 | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [inboundCarrier, setInboundCarrier] = useState("顺丰速运");
  const [inboundTracking, setInboundTracking] = useState("");
  const [receiptNote, setReceiptNote] = useState("");
  const [receivedItems, setReceivedItems] = useState<string[]>(["产品主体"]);
  const [faultReproduced, setFaultReproduced] = useState("yes");
  const [reproductionStatus, setReproductionStatus] = useState("REPRODUCED");
  const [testResult, setTestResult] = useState("");
  const [selectedMaterials, setSelectedMaterials] = useState<
    SelectedMaterial[]
  >([]);
  const [suggestedAction, setSuggestedAction] = useState("维修");
  const [accidentalDamage, setAccidentalDamage] = useState(true);
  const [accidentalDamageType, setAccidentalDamageType] =
    useState("跌落或碰撞");
  const [accidentalDamageNote, setAccidentalDamageNote] = useState("");
  const [localPhotoPreviews, setLocalPhotoPreviews] = useState<
    Record<string, Array<{ id: string; fileName: string; url: string; createdAt: string; saved: boolean }>>
  >({});
  const [photoViewer, setPhotoViewer] = useState<{ url: string; title: string } | null>(null);
  const localPreviewUrlsRef = useRef<string[]>([]);
  const load = () =>
    api<CaseDetailV2>(`/after-sales/${id}`)
      .then((value) => {
        setData(value);
        setInboundCarrier(value.case.inboundCarrier || "顺丰速运");
        setInboundTracking(value.case.inboundTrackingNumber || "");
      })
      .catch((error) => setNotice({ tone: "error", text: errorText(error) }));
  useEffect(() => {
    void load();
  }, [id]);
  useEffect(
    () => () => {
      localPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      localPreviewUrlsRef.current = [];
    },
    [],
  );
  const upload = async (category: string, file: File | undefined) => {
    if (!file) return;
    const previewUrl = URL.createObjectURL(file);
    localPreviewUrlsRef.current.push(previewUrl);
    setLocalPhotoPreviews((current) => ({
      ...current,
      [category]: [
        {
          id: `${category}-${Date.now()}`,
          fileName: file.name || "拍摄照片",
          url: previewUrl,
          createdAt: new Date().toISOString(),
          saved: false,
        },
      ],
    }));
    try {
      const form = new FormData();
      form.append("category", category);
      form.append("file", file);
      const uploaded = await api<{ id: string; dataUrl?: string }>(`/after-sales/${id}/attachments`, {
        method: "POST",
        body: form,
      });
      setLocalPhotoPreviews((current) => ({
        ...current,
        [category]: [{
          id: uploaded.id || `${category}-${Date.now()}`,
          fileName: file.name || "拍摄照片",
          url: uploaded.dataUrl || previewUrl,
          createdAt: new Date().toISOString(),
          saved: true,
        }],
      }));
      setNotice({ tone: "success", text: "图片已上传。" });
      void load();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    }
  };
  const cameraWatermarkLines = [
    "山东省服务中心",
    `工号 ${employeeNumberForUser(user) ?? "9353"}`,
  ];
  const attachmentContentUrl = (attachmentId: string) =>
    `${apiBaseUrl}/after-sales/${id}/attachments/${attachmentId}/content`;
  const removeAttachment = async (category: string, attachmentId: string) => {
    if (!window.confirm("确定删除这张图片吗？删除后需要重新上传。")) return;
    try {
      await api(`/after-sales/${id}/attachments/${attachmentId}`, { method: "DELETE" });
      setLocalPhotoPreviews((current) => ({
        ...current,
        [category]: (current[category] ?? []).filter((item) => item.id !== attachmentId),
      }));
      setNotice({ tone: "success", text: "图片已删除。" });
      void load();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    }
  };
  const photoPreviews = (category: string) => {
    const local = localPhotoPreviews[category] ?? [];
    const uploaded = (data?.attachments ?? []).filter((item) => item.category === category);
    const uploadedOnly = uploaded.filter((item) => !local.some((preview) => preview.id === item.id));
    if (!local.length && !uploadedOnly.length) return null;
    return (
      <div className="service-photo-preview-grid">
        {local.map((item) => (
          <figure key={item.id} className="service-photo-preview">
            <img src={item.url} alt={`${item.fileName} 预览`} />
            <figcaption>{item.fileName}</figcaption>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setPhotoViewer({ url: item.url, title: item.fileName })}
            >
              查看预览
            </button>
            {item.saved ? (
              <button
                type="button"
                className="button button--danger"
                onClick={() => void removeAttachment(category, item.id)}
              >
                删除
              </button>
            ) : (
              <small>正在上传…</small>
            )}
          </figure>
        ))}
        {uploadedOnly.map((item) => {
          const imageUrl = item.dataUrl || attachmentContentUrl(item.id);
          return (
          <figure key={item.id} className="service-photo-preview">
            <img src={imageUrl} alt={`${item.originalFilename} 预览`} />
            <figcaption>{item.originalFilename}</figcaption>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setPhotoViewer({ url: imageUrl, title: item.originalFilename })}
            >
              查看预览
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => void removeAttachment(category, item.id)}
            >
              删除
            </button>
          </figure>
        )})}
      </div>
    );
  };
  const photoUpload = (category: string, label: string) => (
    <div className="photo-upload-field" key={category}>
      <strong>{label}</strong>
      {photoPreviews(category)}
      <div className="photo-upload-actions">
        <label className="button button--secondary">
          {localPhotoPreviews[category]?.length ? "重新选择图片" : "选择图片"}
          <input
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              void upload(category, event.target.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
        </label>
        <CameraPhotoButton
          label={localPhotoPreviews[category]?.length ? "重新拍照" : "摄像头拍照"}
          fileNamePrefix={category}
          watermarkLines={cameraWatermarkLines}
          onCapture={(file) => upload(category, file)}
          onError={(text) => setNotice({ tone: "error", text })}
        />
      </div>
    </div>
  );
  const run = async (path: string, body?: unknown, text = "操作已保存。") => {
    try {
      await api(path, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      setNotice({ tone: "success", text });
      void load();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    }
  };
  const saveInbound = () => {
    if (inboundTracking.trim().length < 3)
      return setNotice({ tone: "error", text: "请填写寄修快递单号。" });
    void run(
      `/after-sales/${id}/inbound-shipment`,
      { carrier: inboundCarrier, trackingNumber: inboundTracking, note: "" },
      "寄修单号已保存。",
    );
  };
  const saveReceipt = (event: FormEvent) => {
    event.preventDefault();
    if (!data) return;
    void run(
      `/after-sales/${id}/receipt`,
      {
        packagingIntact: true,
        packagingNote: "",
        receivedItems,
        itemsMatch: true,
        missingItemsNote: "",
        receiptNote,
      },
      "收货已确认。",
    );
  };
  const submitInspection = (event: FormEvent) => {
    event.preventDefault();
    if (!data) return;
    const missingReason = selectedMaterials.find(
      (item) =>
        item.material.compatibilityStatus === "not_applicable" &&
        !item.compatibilityOverrideReason.trim(),
    );
    if (missingReason)
      return setNotice({
        tone: "error",
        text: `${missingReason.material.materialCode || missingReason.material.materialName} 未适配当前产品，请填写选择原因。`,
      });
    void run(
      `/after-sales/${id}/inspections`,
      {
        faultReproduced,
        reproductionStatus,
        reproductionCondition: "",
        reproductionProcess: "",
        testResult,
        faultParts: [],
        damageTypes: accidentalDamage ? [accidentalDamageType] : [],
        derivedSymptoms: [],
        conclusion: testResult,
        faultCause: "",
        affectedParts: "",
        suggestedAction,
        suggestedParts: "",
        recommendWarranty: false,
        recommendCharge: true,
        engineerNote: "",
        difficulty: "",
        estimatedDays: "",
        accidentalDamage,
        accidentalDamageType,
        accidentalDamageNote,
        faultChains: [],
        repairMaterials: selectedMaterials.map((item) => ({
          materialId: item.material.id,
          quantity: Number(item.quantity),
          handlingMethod: item.handlingMethod,
          useNew: item.useNew,
          reuseExisting: item.reuseExisting,
          repairOnly: item.repairOnly,
          recommendCharge: item.recommendCharge,
          compatibilityOverrideReason: item.compatibilityOverrideReason,
          engineerNote: item.engineerNote,
        })),
      },
      "检测结果已提交管理员审核。",
    );
  };
  return (
    <Shell user={user} route={route}>
      <Header
        title="服务中心收货与检测"
        text={data?.case.caseNo ?? "正在加载工单"}
      />
      {notice && (
        <div
          className={`notice notice--${notice.tone === "error" ? "error" : "info"}`}
        >
          {notice.text}
        </div>
      )}
      {photoViewer && (
        <div className="service-photo-viewer" role="dialog" aria-modal="true">
          <div className="service-photo-viewer__dialog">
            <header>
              <strong>{photoViewer.title}</strong>
              <button type="button" onClick={() => setPhotoViewer(null)} aria-label="关闭图片预览">×</button>
            </header>
            <img src={photoViewer.url} alt={`${photoViewer.title} 大图预览`} />
          </div>
        </div>
      )}
      {!data ? (
        <p>正在加载…</p>
      ) : (
        <div className="order-layout">
          <section className="panel detail-header">
            <div>
              <span className="status">
                {serviceStageName[data.case.serviceStage] ??
                  data.case.serviceStage}
              </span>
              <h2>{data.case.caseNo}</h2>
              <p>
                {data.case.productName || "—"} / {data.case.serialNumber || "—"}
              </p>
            </div>
          </section>
          <section className="panel">
            <h2>工单信息</h2>
            <dl className="detail-grid">
              <dt>经销商</dt>
              <dd>{data.case.dealerName}</dd>
              <dt>店铺</dt>
              <dd>{data.case.storeName || "—"}</dd>
              <dt>客户</dt>
              <dd>
                {data.case.contactName || "—"} / {data.case.contactPhone || "—"}
              </dd>
              <dt>地址</dt>
              <dd>{data.case.contactAddress || "—"}</dd>
              <dt>产品版本</dt>
              <dd>{data.case.productVersion || "—"}</dd>
              <dt>物料编码</dt>
              <dd>{data.case.materialCode || "—"}</dd>
              <dt>问题描述</dt>
              <dd>{data.case.description}</dd>
            </dl>
          </section>
          {data.case.serviceStage === "WAITING_CUSTOMER_SHIPMENT" && (
            <section className="panel">
              <h2>录入寄修单号</h2>
              <label>
                快递公司
                <input
                  value={inboundCarrier}
                  onChange={(event) => setInboundCarrier(event.target.value)}
                />
              </label>
              <label>
                寄修单号
                <input
                  value={inboundTracking}
                  onChange={(event) => setInboundTracking(event.target.value)}
                />
              </label>
              <Button onClick={saveInbound}>保存寄修单号</Button>
            </section>
          )}
          <form className="panel" onSubmit={saveReceipt}>
            <h2>收货确认</h2>
            <fieldset>
              <legend>收到物品清单</legend>
              {receivedItemOptions.map((item) => (
                <label key={item}>
                  <input
                    type="checkbox"
                    checked={receivedItems.includes(item)}
                    onChange={(event) =>
                      setReceivedItems((values) =>
                        toggleValue(values, item, event.target.checked),
                      )
                    }
                  />
                  {item}
                </label>
              ))}
            </fieldset>
            <label>
              收货备注
              <textarea
                value={receiptNote}
                onChange={(event) => setReceiptNote(event.target.value)}
                placeholder="可填写外包装、附件、客户随寄物等情况"
              />
            </label>
            <Button type="submit">确认收货</Button>
          </form>
          {["WAITING_INSPECTION", "INSPECTION_RETURNED"].includes(
            data.case.serviceStage,
          ) && (
            <section className="panel">
              <h2>开始检测</h2>
              <Button
                onClick={() =>
                  void run(
                    `/after-sales/${id}/inspection/start`,
                    undefined,
                    "已开始检测。",
                  )
                }
              >
                开始检测
              </Button>
            </section>
          )}
          <form className="panel" onSubmit={submitInspection}>
            <h2>故障诊断与定损</h2>
            <p className="hint">照片和说明均可后续补充；工程师可先提交定损结果和处理建议给管理员审核。</p>
            <section>
              <h3>客户反馈故障</h3>
              <p>{data.case.description}</p>
              <p className="hint">
                用户备注和工单照片仅用于检测参考，不会自动进入客户报价邮件。
              </p>
            </section>
            <div className="form-layout">
              {facePhotos.map(([category, label]) =>
                photoUpload(category, `产品${label}照片`),
              )}
            </div>
            <label>
              故障是否复现
              <select
                value={reproductionStatus}
                onChange={(event) => {
                  setReproductionStatus(event.target.value);
                  setFaultReproduced(
                    event.target.value === "NOT_REPRODUCED"
                      ? "no"
                      : event.target.value === "INSUFFICIENT_CONDITIONS"
                        ? "uncertain"
                        : "yes",
                  );
                }}
              >
                <option value="REPRODUCED">已复现</option>
                <option value="INTERMITTENT">偶发复现</option>
                <option value="NOT_REPRODUCED">无法复现</option>
                <option value="INSUFFICIENT_CONDITIONS">
                  条件不足，无法检测
                </option>
                <option value="INCONSISTENT_WITH_CUSTOMER">
                  与客户描述不一致
                </option>
              </select>
            </label>
            <label>
              定损结果
              <textarea
                value={testResult}
                onChange={(event) => setTestResult(event.target.value)}
                placeholder="请填写本次检测后的定损结果"
              />
            </label>

            <MaterialSelector
              assetId={data.case.assetId}
              selected={selectedMaterials}
              onChange={setSelectedMaterials}
              notice={setNotice}
            />

            <label>
              建议处理方式
              <select
                value={suggestedAction}
                onChange={(event) => setSuggestedAction(event.target.value)}
              >
                {actionOptions.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>

            <label>
              <input
                type="checkbox"
                checked={accidentalDamage}
                onChange={(event) => setAccidentalDamage(event.target.checked)}
              />{" "}
              存在意外损坏
            </label>
            {accidentalDamage && (
              <>
                <label>
                  意外损坏类型
                  <select
                    value={accidentalDamageType}
                    onChange={(event) =>
                      setAccidentalDamageType(event.target.value)
                    }
                  >
                    {accidentalDamageTypes.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <label>
                  意外损坏说明
                  <textarea
                    value={accidentalDamageNote}
                    onChange={(event) =>
                      setAccidentalDamageNote(event.target.value)
                    }
                  />
                </label>
                {photoUpload("accidental_damage", "意外损坏照片")}
              </>
            )}
            <Button type="submit">提交检测结果</Button>
          </form>
          <section className="panel">
            <h2>历史检测与物料建议</h2>
            {data.inspections.map((item) => (
              <div key={item.id}>
                <p>
                  <strong>检测版本 {item.version}</strong> ·{" "}
                  {item.submittedByName} · {date(item.submittedAt)} ·{" "}
                  {item.status}
                  <br />
                  定损结果：{item.testResult || item.conclusion || "—"}；参考金额：
                  {money(item.materialSuggestedTotalCents)}
                </p>
                <ul>
                  {data.inspectionMaterials
                    .filter((material) => material.inspectionId === item.id)
                    .map((material) => (
                      <li key={material.id}>
                        {material.materialCode} {material.materialName} ×{" "}
                        {material.quantity} ·{" "}
                        {money(material.suggestedTotalCents)} ·{" "}
                        {material.priceStatus}/{material.serviceFeeStatus}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </section>
          <section className="panel">
            <h2>处理记录</h2>
            <ul className="timeline">
              {data.timeline.map((item) => (
                <li key={`${item.eventType}-${item.createdAt}`}>
                  <i />
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {date(item.createdAt)} · {item.actorName || "系统"} ·{" "}
                      {item.description || "—"}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Shell>
  );
}

export function ServiceCenterPortal({
  user,
  route,
}: {
  user: SessionUser;
  route: string;
}) {
  const path = route.split("?")[0];
  const logout = async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      location.hash = "#/login";
    }
  };
  if (path.startsWith("/system/service-center/assets"))
    return <GsxPortal user={user} route={route} logout={logout} />;
  if (path.startsWith("/system/service-center/cases/"))
    return (
      <CasePageV2 user={user} route={route} id={path.split("/").at(-1)!} />
    );
  return <CaseListV2 user={user} route={route} />;
}
