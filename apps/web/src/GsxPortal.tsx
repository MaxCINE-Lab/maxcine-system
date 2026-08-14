import {
  Fragment,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as XLSX from "xlsx";
import { HISTORICAL_WARRANTY_COLUMNS, type SessionUser } from "@maxcine/shared";
import { api, ApiClientError } from "./api";
import { Shell } from "./OperationsPortal";

type Props = { user: SessionUser; route: string; logout: () => void };
type Notice = { tone: "success" | "error"; text: string } | null;
type ImportIssue = {
  severity: "warning" | "error";
  code: string;
  message: string;
};
type ImportPreview = {
  batch: {
    id: string;
    sourceFilename: string;
    sourceSheet: string;
    status: string;
    totalRows: number;
    normalRows: number;
    warningRows: number;
    errorRows: number;
    confirmedAt: string | null;
  };
  rows: Array<{
    rowNumber: number;
    sequence: string;
    currentSn: string | null;
    originalSn: string | null;
    version: string;
    sourceChannel: string;
    issues: ImportIssue[];
    disposition: string;
  }>;
  alreadyPrepared?: boolean;
  alreadyCompleted?: boolean;
  importedRows?: number;
  skippedRows?: number;
};
type Asset = {
  id: string;
  currentSn: string | null;
  originalSn?: string | null;
  productName: string;
  version: string;
  sourceChannel: string;
  shippingWarehouse: string;
  warrantyStatus: string;
  warrantyEndAt: string | null;
  assetStatus: string;
  dataQualityStatus: string;
  latestEvent: string | null;
  updatedAt: string;
};
type AssetListResponse = {
  items: Asset[];
  filters: { versions: string[]; channels: string[]; warehouses: string[] };
  pagination: { page: number; total: number; totalPages: number };
};
type AssetPhoto = {
  id: string;
  source: "shipment" | "after_sales";
  category: string;
  photoSlot?: string;
  dataUrl: string;
  originalFilename: string;
  contentType: string;
  uploadedByName: string | null;
  createdAt: string;
  relatedNo: string | null;
  trackingNumber?: string | null;
};
type PublicWarranty = {
  id: string;
  publicWarrantyStartDate: string | null;
  publicWarrantyEndDate: string | null;
  publicWarrantyStatus: string;
  publicNote: string;
  isPublicQueryEnabled: number;
  warrantyStatus: string;
  updatedAt: string;
};
type FactoryPhoto = {
  id: string;
  photoType: string | null;
  originalFilename: string;
  contentType: string;
  fileSize: number;
  remark: string;
  uploadedAt: string;
  uploadedByName: string | null;
  contentUrl: string;
};
type AssetDetail = {
  asset: {
    id: string;
    currentSn: string | null;
    originalSn: string | null;
    productId: string | null;
    productName: string;
    version: string;
    sku: string | null;
    materialCode: string | null;
    assetStatus: string;
    warrantyPolicy: string;
    warrantyStartAt: string | null;
    warrantyEndAt: string | null;
    warrantyOverrideStatus: string | null;
    warrantyOverrideReason: string;
    warrantyStatus: string;
    warrantyDays: number | null;
    sourceChannel: string;
    shippingWarehouse: string;
    dealerId: string | null;
    dealerName: string | null;
    storeId: string | null;
    storeName: string | null;
    latestOrderId: string | null;
    latestOrderNo: string | null;
    orderStatus: string | null;
    salePriceCents: number | null;
    shippingAddress: string | null;
    customerProfile: string | null;
    screenshotDataUrl: string | null;
    dataQualityStatus: string;
    updatedByName: string | null;
    createdAt: string;
    updatedAt: string;
  };
  identifiers: Array<{
    identifierType: string;
    identifierValue: string;
    isCurrent: number;
    validFrom: string | null;
    validTo: string | null;
    reason: string;
    source: string;
    createdAt: string;
  }>;
  events: Array<{
    id: string;
    eventType: string;
    occurredAt: string | null;
    title: string;
    description: string;
    relatedOrderId: string | null;
    relatedServiceCaseId: string | null;
    operatorName: string | null;
    visibility: string;
    source: string;
    createdAt: string;
  }>;
  serviceCases: Array<{
    id: string;
    caseNo: string;
    status: string;
    workflowStage: string;
    subject: string;
    description?: string;
    serviceCenterName?: string | null;
    inspectionResult?: string | null;
    recommendation?: string | null;
    finalResult?: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  notes: Array<{
    category: string;
    content: string;
    source: string;
    createdAt: string;
    updatedAt?: string;
  }>;
  sales: Array<{
    sourceChannel: string;
    purchaseDate: string | null;
    trackingNumber: string | null;
    shippingWarehouse: string;
    purchasePriceRaw?: string;
    paymentRaw?: string;
    paymentStatus?: string;
  }>;
  audit: Array<{ action: string; createdAt: string; actorName: string | null }>;
  publicWarranty: PublicWarranty | null;
  factoryPhotos: FactoryPhoto[];
  photos: AssetPhoto[];
};

const inputText = (value: unknown) =>
  value === null || value === undefined ? "" : String(value).trim();
const errorText = (error: unknown) => {
  if (!(error instanceof ApiClientError)) return "系统繁忙，请稍后再试。";
  if (error.code === "UNAUTHENTICATED") return "登录状态已失效，请重新登录。";
  if (error.code === "FORBIDDEN") return "你没有权限查看该资产。";
  if (error.code === "NOT_FOUND") return "未找到相关资产。";
  if (error.code === "INTERNAL_ERROR") return "系统繁忙，请稍后再试。";
  return error.message || "操作未完成，请稍后重试。";
};
const date = (value: string | null | undefined) =>
  value
    ? /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : new Intl.DateTimeFormat("zh-CN", {
          dateStyle: "medium",
          timeStyle: "short",
          hour12: false,
        }).format(new Date(`${value.replace(" ", "T")}Z`))
    : "—";
const statusTone = (value: string) =>
  value === "保修中" || value === "active"
    ? "good"
    : [
          "异常",
          "拒保",
          "注销",
          "报废",
          "duplicate_identifier",
          "invalid_identifier",
          "missing_identifier",
        ].includes(value)
      ? "risk"
      : "neutral";
const assetStatusName: Record<string, string> = {
  active: "在库",
  in_service: "使用中",
  refurbished: "已翻新",
  returned_to_inventory: "已退回库存",
  resold: "已重新销售",
  scrapped: "已报废",
  unknown: "待核验",
};
const dataQualityName: Record<string, string> = {
  normal: "正常",
  warning: "待核验",
  duplicate_identifier: "重复标签",
  invalid_identifier: "标签异常",
  missing_identifier: "缺少 SN",
};
const photoCategoryName: Record<string, string> = {
  box_sn: "盒面 SN 照片",
  packed_photo_1: "打包完成照片 1",
  packed_photo_2: "打包完成照片 2",
  customer_problem_photo: "客户问题照片",
  package_label: "外包装及面单照片",
  received_items_front: "全部物品正面照片",
  received_items_back: "全部物品反面照片",
  product_front: "产品正面照片",
  product_back: "产品背面照片",
  product_left: "产品左侧照片",
  product_right: "产品右侧照片",
  product_top: "产品顶部照片",
  product_bottom: "产品底部照片",
  accidental_damage: "意外损坏照片",
  inspection_other: "其他检测照片",
};
function assetBase(route: string): string {
  if (route.startsWith("/system/service-center")) return "/system/service-center/assets";
  if (route.startsWith("/system/assets")) return "/system/assets";
  return "/system/admin/assets";
}

function GsxTabs({
  route,
  active,
  canImport: _canImport,
}: {
  route: string;
  active: string;
  canImport: boolean;
}) {
  const base = assetBase(route);
  const tabs = [
    ["SN 查询", base],
    ["资产列表", `${base}/list`],
    ["保修中", `${base}/warranty`],
    ["异常资产", `${base}/exceptions`],
    [
      "售后工单",
      route.startsWith("/system/service-center")
        ? "/system/service-center"
        : "/system/admin/after-sales",
    ],
  ];
  return (
    <nav className="gsx-tabs" aria-label="资产与保修菜单">
      {tabs.map(([label, href]) => (
        <a
          key={href}
          href={`#${href}`}
          className={active === href ? "is-active" : ""}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

function Notice({ notice }: { notice: Notice }) {
  return notice ? (
    <div
      className={`notice notice--${notice.tone === "error" ? "error" : "info"}`}
    >
      {notice.text}
    </div>
  ) : null;
}
function Pill({ value }: { value: string }) {
  return (
    <span className={`status gsx-status gsx-status--${statusTone(value)}`}>
      {dataQualityName[value] ?? assetStatusName[value] ?? value}
    </span>
  );
}

async function fingerprint(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (part) =>
    part.toString(16).padStart(2, "0"),
  ).join("");
}

async function readHistoricalWarranty(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
  const sourceSheet = workbook.SheetNames[0];
  if (!sourceSheet) throw new Error("未找到可读取的工作表。");
  const values = XLSX.utils.sheet_to_json<unknown[]>(
    workbook.Sheets[sourceSheet],
    { header: 1, raw: true, defval: null },
  );
  const headerIndex = values.findIndex(
    (row) =>
      Array.isArray(row) &&
      HISTORICAL_WARRANTY_COLUMNS.every((column) =>
        row.some((cell) => inputText(cell) === column),
      ),
  );
  if (headerIndex < 0)
    throw new Error("未识别到当前历史保修表的完整表头，请使用原始文件。");
  const headerRow = values[headerIndex];
  const headers = headerRow.map(inputText).filter(Boolean);
  const index = new Map(
    headerRow.map((cell, columnIndex) => [inputText(cell), columnIndex]),
  );
  const records = values
    .slice(headerIndex + 1)
    .map((row, offset) => {
      const source: Record<string, string | number | boolean | null> = {};
      for (const column of HISTORICAL_WARRANTY_COLUMNS) {
        const value = row[index.get(column)!];
        source[column] =
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          value === null
            ? value
            : inputText(value);
      }
      return { rowNumber: headerIndex + offset + 2, values: source };
    })
    .filter((record) =>
      Object.values(record.values).some((value) => inputText(value)),
    );
  if (!records.length) throw new Error("未读取到历史保修记录。");
  return {
    sourceSheet,
    headers,
    records,
    sourceFileFingerprint: await fingerprint(arrayBuffer),
  };
}

function SearchHome({ user, route, logout }: Props) {
  const base = assetBase(route);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Asset[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [recentQueries, setRecentQueries] = useState<string[]>(() => {
    try {
      return JSON.parse(
        sessionStorage.getItem("maxcine-gsx-recent-queries") || "[]",
      ) as string[];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const search = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = query.replace(/[\r\n\t]/g, "").trim();
    setNotice(null);
    setItems([]);
    setHasSearched(true);
    if (normalized.length < 4) {
      setNotice({ tone: "error", text: "请输入至少 4 位 SN 或资产标识。" });
      return;
    }
    setSearching(true);
    try {
      const result = await api<{ items: Asset[] }>(
        `/gsx/search?q=${encodeURIComponent(normalized)}`,
      );
      const next = [
        normalized,
        ...recentQueries.filter((item) => item !== normalized),
      ].slice(0, 5);
      setRecentQueries(next);
      sessionStorage.setItem(
        "maxcine-gsx-recent-queries",
        JSON.stringify(next),
      );
      if (result.items.length === 1) {
        location.hash = `#${base}/${result.items[0].id}`;
        return;
      }
      setItems(result.items);
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally {
      setSearching(false);
    }
  };
  return (
    <Shell
      user={user}
      route={route}
      title="SN 查询"
      subtitle="输入完整或部分 SN，快速打开资产详情。"
      logout={logout}
    >
      <GsxTabs
        route={route}
        active={base}
        canImport={user.permissions.includes("asset:import")}
      />
      <section className="panel gsx-search">
        <form onSubmit={search}>
          <label htmlFor="gsx-search">SN 或资产标识</label>
          <div className="gsx-search-row">
            <input
              ref={inputRef}
              id="gsx-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="至少输入 4 位，例如 6901、495333 或完整 SN"
              minLength={4}
            />
            <button className="button" type="submit" disabled={searching}>
              {searching ? "正在查询…" : "查询"}
            </button>
          </div>
        </form>
        {recentQueries.length > 0 && (
          <div className="gsx-recent-queries">
            <span>最近查询</span>
            {recentQueries.map((item) => (
              <button
                type="button"
                key={item}
                onClick={() => {
                  setQuery(item);
                  inputRef.current?.focus();
                }}
              >
                {item}
              </button>
            ))}
          </div>
        )}
      </section>
      <Notice notice={notice} />
      {searching && (
        <section className="panel gsx-search-loading" aria-live="polite">
          <span className="skeleton" />
          <span className="skeleton" />
          <p>正在查询资产…</p>
        </section>
      )}
      {hasSearched && !searching && !notice && !items.length && (
        <section className="empty-state gsx-search-empty">
          <h2>未找到匹配的 SN 或资产标识。</h2>
        </section>
      )}
      {items.length > 1 && (
        <section className="panel">
          <div className="panel-title">
            <h2>查询结果</h2>
            <span>{items.length} 条</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>当前 SN</th>
                  <th>原始 SN</th>
                  <th>产品名称</th>
                  <th>产品版本</th>
                  <th>资产状态</th>
                  <th>保修状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.currentSn || "待补充"}</td>
                    <td>{item.originalSn || "—"}</td>
                    <td>{item.productName}</td>
                    <td>{item.version || "—"}</td>
                    <td>
                      <Pill value={item.assetStatus} />
                    </td>
                    <td>
                      <Pill value={item.warrantyStatus} />
                    </td>
                    <td>
                      <a href={`#${base}/${item.id}`}>查看</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </Shell>
  );
}

function AssetList({
  user,
  route,
  logout,
  mode = "all",
}: Props & { mode?: "all" | "warranty" | "exceptions" }) {
  const [data, setData] = useState<AssetListResponse | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [search, setSearch] = useState("");
  const [version, setVersion] = useState("");
  const [channel, setChannel] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [quality, setQuality] = useState("");
  const [page, setPage] = useState(1);
  const base = assetBase(route);
  const fixed =
    mode === "warranty"
      ? "warrantyStatus=保修中"
      : mode === "exceptions"
        ? "quality=exception"
        : "";
  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), limit: "30" });
    if (search) params.set("search", search);
    if (version) params.set("version", version);
    if (channel) params.set("channel", channel);
    if (warehouse) params.set("warehouse", warehouse);
    if (quality) params.set("quality", quality);
    if (fixed) {
      const [key, value] = fixed.split("=");
      params.set(key, value);
    }
    return params.toString();
  }, [search, version, channel, warehouse, quality, fixed, page]);
  const load = useCallback(() => {
    void api<AssetListResponse>(`/assets?${query}`)
      .then(setData)
      .catch((error) => setNotice({ tone: "error", text: errorText(error) }));
  }, [query]);
  useEffect(() => {
    load();
  }, [load]);
  const title =
    mode === "warranty"
      ? "保修中资产"
      : mode === "exceptions"
        ? "异常资产"
        : "资产列表";
  const subtitle =
    mode === "warranty"
      ? "查看当前仍在有效保修期内的资产。"
      : mode === "exceptions"
        ? "查看需要人工核验 SN、保修或历史数据的资产。"
        : "查看历史与当前资产的保修状态和生命周期。";
  return (
    <Shell
      user={user}
      route={route}
      title={title}
      subtitle={subtitle}
      logout={logout}
    >
      <GsxTabs
        route={route}
        active={
          mode === "all"
            ? `${base}/list`
            : mode === "warranty"
              ? `${base}/warranty`
              : `${base}/exceptions`
        }
        canImport={user.permissions.includes("asset:import")}
      />
      <Notice notice={notice} />
      <section className="toolbar gsx-filter">
        <input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder="搜索当前 SN、原 SN 或产品"
        />
        <select
          value={version}
          onChange={(event) => {
            setVersion(event.target.value);
            setPage(1);
          }}
        >
          <option value="">全部版本</option>
          {data?.filters.versions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          value={channel}
          onChange={(event) => {
            setChannel(event.target.value);
            setPage(1);
          }}
        >
          <option value="">全部销售渠道</option>
          {data?.filters.channels.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          value={warehouse}
          onChange={(event) => {
            setWarehouse(event.target.value);
            setPage(1);
          }}
        >
          <option value="">全部发货仓库</option>
          {data?.filters.warehouses.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        {mode !== "exceptions" && (
          <select
            value={quality}
            onChange={(event) => {
              setQuality(event.target.value);
              setPage(1);
            }}
          >
            <option value="">全部数据质量</option>
            <option value="normal">正常</option>
            <option value="warning">待核验</option>
            <option value="duplicate_identifier">重复标签</option>
            <option value="invalid_identifier">标签异常</option>
            <option value="missing_identifier">缺少 SN</option>
          </select>
        )}
      </section>
      {!data ? (
        <p>正在加载…</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>当前 SN</th>
                  <th>产品与版本</th>
                  <th>销售渠道</th>
                  <th>保修状态</th>
                  <th>保修结束</th>
                  <th>资产状态</th>
                  <th>最近事件</th>
                  <th>数据质量</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.currentSn || "待补充"}</td>
                    <td>
                      {item.productName}
                      <br />
                      <small>{item.version || "未标注版本"}</small>
                    </td>
                    <td>{item.sourceChannel || "—"}</td>
                    <td>
                      <Pill value={item.warrantyStatus} />
                    </td>
                    <td>{date(item.warrantyEndAt)}</td>
                    <td>{item.assetStatus}</td>
                    <td>{item.latestEvent || "—"}</td>
                    <td>
                      <Pill
                        value={
                          item.dataQualityStatus === "normal"
                            ? "正常"
                            : item.dataQualityStatus === "warning"
                              ? "待核验"
                              : item.dataQualityStatus ===
                                  "duplicate_identifier"
                                ? "重复标签"
                                : item.dataQualityStatus ===
                                    "invalid_identifier"
                                  ? "标签异常"
                                  : "缺少 SN"
                        }
                      />
                    </td>
                    <td>
                      <a href={`#${base}/${item.id}`}>查看详情</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.items.length && (
              <div className="empty-state">
                <h2>暂无符合条件的资产。</h2>
              </div>
            )}
          </div>
          {data.pagination.totalPages > 1 && (
            <div className="pagination">
              <button
                className="button button--secondary"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                上一页
              </button>
              <span>
                第 {data.pagination.page} / {data.pagination.totalPages} 页，共{" "}
                {data.pagination.total} 条
              </span>
              <button
                className="button button--secondary"
                disabled={page >= data.pagination.totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}

function ImportPage({ user, route, logout }: Props) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [importSearch, setImportSearch] = useState("");
  const [onlyIssues, setOnlyIssues] = useState(false);
  const mappingRows = [
    ["序号", "导入源序号 / 原始行快照"],
    ["销售渠道", "销售来源与资产来源渠道"],
    ["版本", "产品版本快照"],
    ["购买日期、购买价格、到账状态", "销售记录快照，金额异常保留原文"],
    ["SN、发出单号", "资产当前标识、历史标识与物流单号"],
    ["保修状态、保修开始、保修结束", "保修策略、人工覆盖与日期字段"],
    ["维修记录1～4", "资产生命周期事件"],
    ["备注1～5、用户画像", "内部备注；敏感内容仅管理员可见"],
  ];
  const visibleRows = preview
    ? preview.rows.filter((row) => {
        const queryText = importSearch.trim().toLowerCase();
        const haystack = [
          row.rowNumber,
          row.sequence,
          row.currentSn,
          row.originalSn,
          row.version,
          row.sourceChannel,
          row.issues.map((issue) => issue.message).join(" "),
          row.disposition,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return (
          (!onlyIssues || row.issues.length > 0) &&
          (!queryText || haystack.includes(queryText))
        );
      })
    : [];
  const previewRows = visibleRows.slice(0, 20);
  const selectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setNotice(null);
    setPreview(null);
    try {
      const source = await readHistoricalWarranty(file);
      const result = await api<ImportPreview>("/admin/gsx/imports/precheck", {
        method: "POST",
        body: JSON.stringify({ sourceFilename: file.name, ...source }),
      });
      setPreview(result);
      setImportSearch("");
      setOnlyIssues(false);
      setNotice({
        tone: "success",
        text: result.alreadyPrepared
          ? "该文件已有预检查记录，可继续确认导入。"
          : "预检查完成，请查看警告和错误后确认导入。",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text:
          error instanceof Error && !(error instanceof ApiClientError)
            ? error.message
            : errorText(error),
      });
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  };
  const confirm = async () => {
    if (
      !preview ||
      !window.confirm(
        "确认导入可处理的历史保修记录吗？导入后会生成资产、销售记录和生命周期事件。",
      )
    )
      return;
    setBusy(true);
    setNotice(null);
    try {
      const skipRowNumbers = preview.rows
        .filter((row) => row.issues.some((issue) => issue.severity === "error"))
        .map((row) => row.rowNumber);
      const result = await api<ImportPreview>(
        `/admin/gsx/imports/${preview.batch.id}/confirm`,
        { method: "POST", body: JSON.stringify({ skipRowNumbers }) },
      );
      setPreview(result);
      setNotice({
        tone: "success",
        text: result.alreadyCompleted
          ? "该文件此前已完成导入，未重复创建记录。"
          : `导入完成：已导入 ${result.importedRows ?? 0} 条，跳过 ${result.skippedRows ?? 0} 条。`,
      });
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const cancelPreview = () => {
    setPreview(null);
    setImportSearch("");
    setOnlyIssues(false);
    setNotice({
      tone: "success",
      text: "已取消本次预检查，未写入正式资产数据。",
    });
  };
  const downloadIssueRows = () => {
    if (!preview) return;
    const issueRows = preview.rows.filter((row) => row.issues.length > 0);
    if (!issueRows.length) {
      setNotice({ tone: "success", text: "当前没有异常行需要下载。" });
      return;
    }
    const encode = (value: unknown) =>
      `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [
      ["原表行号", "序号", "SN", "版本", "问题", "处理方式"]
        .map(encode)
        .join(","),
      ...issueRows.map((row) =>
        [
          row.rowNumber,
          row.sequence,
          row.currentSn || row.originalSn,
          row.version,
          row.issues.map((issue) => issue.message).join("；"),
          row.disposition,
        ]
          .map(encode)
          .join(","),
      ),
    ].join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `maxcine-import-issues-${preview.batch.id}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Shell
      user={user}
      route={route}
      title="历史数据导入"
      subtitle="先预检查，再确认写入；异常行不会阻断整批处理。"
      logout={logout}
    >
      <GsxTabs route={route} active={`${assetBase(route)}/import`} canImport />
      <Notice notice={notice} />
      <section className="panel">
        <h2>选择历史保修表</h2>
        <p>
          仅支持当前结构的 .xlsx
          文件。预检查只写入导入暂存记录，不会立即生成资产或保修记录。
        </p>
        <label className="button button--secondary">
          {busy ? "正在处理…" : "选择 .xlsx 文件"}
          <input
            type="file"
            accept=".xlsx"
            hidden
            disabled={busy}
            onChange={(event) => void selectFile(event)}
          />
        </label>
      </section>
      {preview && (
        <section className="panel">
          <div className="panel-title">
            <h2>预检查结果</h2>
            <span>
              {preview.batch.status === "prepared" ? "等待确认" : "已完成"}
            </span>
          </div>
          <div className="stats gsx-import-stats">
            <article className="stat">
              <p>记录总数</p>
              <strong>{preview.batch.totalRows}</strong>
            </article>
            <article className="stat">
              <p>正常记录</p>
              <strong>{preview.batch.normalRows}</strong>
            </article>
            <article className="stat">
              <p>警告记录</p>
              <strong>{preview.batch.warningRows}</strong>
            </article>
            <article className="stat">
              <p>错误记录</p>
              <strong>{preview.batch.errorRows}</strong>
            </article>
          </div>
          <div className="form-section">
            <h3>字段映射</h3>
            <div className="table-wrap compact-table">
              <table>
                <thead>
                  <tr>
                    <th>Excel 字段</th>
                    <th>建议映射</th>
                  </tr>
                </thead>
                <tbody>
                  {mappingRows.map(([source, target]) => (
                    <tr key={source}>
                      <td>{source}</td>
                      <td>{target}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="filter-row">
            <input
              value={importSearch}
              onChange={(event) => setImportSearch(event.target.value)}
              placeholder="搜索 SN、序号、版本或检查结果"
            />
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={onlyIssues}
                onChange={(event) => setOnlyIssues(event.target.checked)}
              />
              仅显示异常行
            </label>
            <button
              type="button"
              className="button button--secondary"
              onClick={downloadIssueRows}
            >
              下载异常行
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={cancelPreview}
            >
              取消本次预检查
            </button>
          </div>
          <p className="muted">
            当前显示 {previewRows.length} / {visibleRows.length}{" "}
            条，预览最多显示前 20 行。
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>原表行号</th>
                  <th>序号</th>
                  <th>当前 SN</th>
                  <th>版本</th>
                  <th>检查结果</th>
                  <th>处理方式</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row) => (
                  <tr key={row.rowNumber}>
                    <td>{row.rowNumber}</td>
                    <td>{row.sequence || "—"}</td>
                    <td>{row.currentSn || row.originalSn || "缺少 SN"}</td>
                    <td>{row.version || "—"}</td>
                    <td>
                      {row.issues.length
                        ? row.issues.map((issue) => (
                            <p
                              className={
                                issue.severity === "error" ? "text-danger" : ""
                              }
                              key={`${issue.code}-${issue.message}`}
                            >
                              {issue.message}
                            </p>
                          ))
                        : "正常"}
                    </td>
                    <td>
                      {row.disposition === "imported"
                        ? "已导入"
                        : row.disposition === "skipped"
                          ? "已跳过"
                          : row.issues.some(
                                (issue) => issue.severity === "error",
                              )
                            ? "确认时跳过"
                            : "确认后导入"}
                    </td>
                  </tr>
                ))}
                {!previewRows.length && (
                  <tr>
                    <td colSpan={6}>没有符合条件的预检查记录。</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {preview.batch.status === "prepared" && (
            <div className="action-list">
              <button
                className="button"
                onClick={() => void confirm()}
                disabled={busy}
              >
                确认导入
              </button>
            </div>
          )}
        </section>
      )}
    </Shell>
  );
}

function AssetEditModal({
  data,
  onClose,
  onSaved,
}: {
  data: AssetDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const asset = data.asset;
  const [form, setForm] = useState({
    currentSn: asset.currentSn || "",
    originalSn: asset.originalSn || "",
    productName: asset.productName || "",
    version: asset.version || "",
    assetStatus: asset.assetStatus,
    warrantyStartAt: asset.warrantyStartAt || "",
    warrantyEndAt: asset.warrantyEndAt || "",
    warrantyOverrideStatus: asset.warrantyOverrideStatus || "",
    warrantyOverrideReason: asset.warrantyOverrideReason || "",
    sourceChannel: asset.sourceChannel || "",
    shippingWarehouse: asset.shippingWarehouse || "",
    latestOrderId: asset.latestOrderId || "",
    noteContent: "",
  });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const update = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    const patch: Record<string, string | null> = {};
    const pairs: Array<[keyof typeof form, unknown]> = [
      ["currentSn", asset.currentSn || ""],
      ["originalSn", asset.originalSn || ""],
      ["productName", asset.productName || ""],
      ["version", asset.version || ""],
      ["assetStatus", asset.assetStatus],
      ["warrantyStartAt", asset.warrantyStartAt || ""],
      ["warrantyEndAt", asset.warrantyEndAt || ""],
      ["warrantyOverrideStatus", asset.warrantyOverrideStatus || ""],
      ["warrantyOverrideReason", asset.warrantyOverrideReason || ""],
      ["sourceChannel", asset.sourceChannel || ""],
      ["shippingWarehouse", asset.shippingWarehouse || ""],
      ["latestOrderId", asset.latestOrderId || ""],
    ];
    for (const [key, before] of pairs)
      if (form[key] !== before)
        patch[key] =
          [
            "originalSn",
            "warrantyStartAt",
            "warrantyEndAt",
            "warrantyOverrideStatus",
            "latestOrderId",
          ].includes(key) && !form[key]
            ? null
            : form[key];
    if (form.noteContent.trim()) patch.noteContent = form.noteContent.trim();
    if (!Object.keys(patch).length) {
      onClose();
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      await api(`/admin/assets/${asset.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      onSaved();
      onClose();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="asset-edit-backdrop" role="dialog" aria-modal="true">
      <div className="asset-edit-dialog">
        <header>
          <div>
            <h2>编辑全部信息</h2>
            <p>{asset.currentSn || asset.originalSn || "历史资产"}</p>
          </div>
          <button onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="asset-edit-body">
          <Notice notice={notice} />
          <section>
            <h3>资产信息</h3>
            <label>
              当前 SN
              <input
                value={form.currentSn}
                onChange={(event) => update("currentSn", event.target.value)}
              />
            </label>
            <label>
              原始 SN
              <input
                value={form.originalSn}
                onChange={(event) => update("originalSn", event.target.value)}
              />
            </label>
            <label>
              产品名称
              <input
                value={form.productName}
                onChange={(event) => update("productName", event.target.value)}
              />
            </label>
            <label>
              产品版本
              <input
                value={form.version}
                onChange={(event) => update("version", event.target.value)}
              />
            </label>
            <label>
              资产状态
              <select
                value={form.assetStatus}
                onChange={(event) => update("assetStatus", event.target.value)}
              >
                <option value="active">在库</option>
                <option value="in_service">使用中</option>
                <option value="refurbished">已翻新</option>
                <option value="returned_to_inventory">已退回库存</option>
                <option value="resold">已重新销售</option>
                <option value="scrapped">已报废</option>
                <option value="unknown">待核验</option>
              </select>
            </label>
          </section>
          <section>
            <h3>保修信息</h3>
            <label>
              保修开始
              <input
                type="date"
                value={form.warrantyStartAt}
                onChange={(event) =>
                  update("warrantyStartAt", event.target.value)
                }
              />
            </label>
            <label>
              保修结束
              <input
                type="date"
                value={form.warrantyEndAt}
                onChange={(event) =>
                  update("warrantyEndAt", event.target.value)
                }
              />
            </label>
            <label>
              人工覆盖
              <select
                value={form.warrantyOverrideStatus}
                onChange={(event) =>
                  update("warrantyOverrideStatus", event.target.value)
                }
              >
                <option value="">按日期计算</option>
                <option value="no_warranty">无保修</option>
                <option value="denied">拒保</option>
                <option value="exception">异常</option>
                <option value="cancelled">注销</option>
                <option value="scrapped">报废</option>
              </select>
            </label>
            <label>
              覆盖原因
              <input
                value={form.warrantyOverrideReason}
                onChange={(event) =>
                  update("warrantyOverrideReason", event.target.value)
                }
                placeholder="修改保修信息时必填"
              />
            </label>
          </section>
          <section>
            <h3>销售与物流</h3>
            <label>
              销售渠道
              <input
                value={form.sourceChannel}
                onChange={(event) =>
                  update("sourceChannel", event.target.value)
                }
              />
            </label>
            <label>
              发货仓库
              <input
                value={form.shippingWarehouse}
                onChange={(event) =>
                  update("shippingWarehouse", event.target.value)
                }
              />
            </label>
            <label>
              关联订单 ID
              <input
                value={form.latestOrderId}
                onChange={(event) =>
                  update("latestOrderId", event.target.value)
                }
              />
            </label>
          </section>
          <section>
            <h3>备注</h3>
            <label>
              管理员内部说明
              <textarea
                value={form.noteContent}
                onChange={(event) => update("noteContent", event.target.value)}
                placeholder="可一次补充内部备注"
              />
            </label>
          </section>
        </div>
        <footer>
          <button
            className="button button--secondary"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </button>
          <button
            className="button"
            onClick={() => void submit()}
            disabled={saving}
          >
            {saving ? "正在保存…" : "保存全部修改"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="panel asset-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function DetailRows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="detail-grid compact-detail">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value || "—"}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function PublicWarrantyEditor({
  asset,
  publicWarranty,
  onSaved,
}: {
  asset: AssetDetail["asset"];
  publicWarranty: PublicWarranty | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [form, setForm] = useState({
    publicWarrantyStartDate:
      publicWarranty?.publicWarrantyStartDate || asset.warrantyStartAt || "",
    publicWarrantyEndDate:
      publicWarranty?.publicWarrantyEndDate || asset.warrantyEndAt || "",
    publicWarrantyStatus: publicWarranty?.publicWarrantyStatus || "auto",
    publicNote: publicWarranty?.publicNote || "",
    isPublicQueryEnabled: publicWarranty
      ? Boolean(publicWarranty.isPublicQueryEnabled)
      : true,
  });
  useEffect(
    () =>
      setForm({
        publicWarrantyStartDate:
          publicWarranty?.publicWarrantyStartDate ||
          asset.warrantyStartAt ||
          "",
        publicWarrantyEndDate:
          publicWarranty?.publicWarrantyEndDate || asset.warrantyEndAt || "",
        publicWarrantyStatus: publicWarranty?.publicWarrantyStatus || "auto",
        publicNote: publicWarranty?.publicNote || "",
        isPublicQueryEnabled: publicWarranty
          ? Boolean(publicWarranty.isPublicQueryEnabled)
          : true,
      }),
    [asset.warrantyEndAt, asset.warrantyStartAt, publicWarranty],
  );
  const save = async () => {
    setNotice(null);
    try {
      await api(`/admin/assets/${asset.id}/public-warranty`, {
        method: "PATCH",
        body: JSON.stringify({
          publicWarrantyStartDate: form.publicWarrantyStartDate || null,
          publicWarrantyEndDate: form.publicWarrantyEndDate || null,
          publicWarrantyStatus: form.publicWarrantyStatus,
          publicNote: form.publicNote,
          isPublicQueryEnabled: form.isPublicQueryEnabled,
        }),
      });
      setEditing(false);
      onSaved();
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    }
  };
  if (!editing) {
    return (
      <>
        <DetailRows
          rows={[
            [
              "公开查询",
              publicWarranty?.isPublicQueryEnabled ? "允许" : "不允许",
            ],
            ["官网展示状态", publicWarranty?.warrantyStatus || "未初始化"],
            ["公开保修开始", date(publicWarranty?.publicWarrantyStartDate)],
            ["公开保修结束", date(publicWarranty?.publicWarrantyEndDate)],
            ["公开备注", publicWarranty?.publicNote],
            ["最后更新时间", date(publicWarranty?.updatedAt)],
          ]}
        />
        <button
          className="button button--secondary"
          onClick={() => setEditing(true)}
        >
          编辑官网展示数据
        </button>
      </>
    );
  }
  return (
    <div className="form-layout">
      <Notice notice={notice} />
      <label>
        允许公开查询
        <select
          value={String(form.isPublicQueryEnabled)}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              isPublicQueryEnabled: event.target.value === "true",
            }))
          }
        >
          <option value="true">允许</option>
          <option value="false">不允许</option>
        </select>
      </label>
      <label>
        公开保修状态
        <select
          value={form.publicWarrantyStatus}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              publicWarrantyStatus: event.target.value,
            }))
          }
        >
          <option value="auto">按日期自动计算</option>
          <option value="pending">待生效</option>
          <option value="active">保修中</option>
          <option value="expired">已过保</option>
          <option value="no_warranty">无保修</option>
          <option value="blocked">不可查询</option>
          <option value="hidden">隐藏</option>
          <option value="unknown">待确认</option>
        </select>
      </label>
      <label>
        公开保修开始
        <input
          type="date"
          value={form.publicWarrantyStartDate}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              publicWarrantyStartDate: event.target.value,
            }))
          }
        />
      </label>
      <label>
        公开保修结束
        <input
          type="date"
          value={form.publicWarrantyEndDate}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              publicWarrantyEndDate: event.target.value,
            }))
          }
        />
      </label>
      <label>
        官网公开备注
        <textarea
          value={form.publicNote}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              publicNote: event.target.value,
            }))
          }
        />
      </label>
      <div className="action-list">
        <button className="button" onClick={() => void save()}>
          保存公开保修
        </button>
        <button
          className="button button--secondary"
          onClick={() => setEditing(false)}
        >
          取消
        </button>
      </div>
    </div>
  );
}

function PendingFactoryPhoto({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);
  return (
    <figure className="factory-photo-card factory-photo-card--pending">
      <img src={previewUrl} alt={`${file.name} 待上传预览`} />
      <figcaption>
        <strong>待上传</strong>
        <span>{file.name}</span>
      </figcaption>
      <button
        type="button"
        className="table-action table-action--danger"
        onClick={onRemove}
      >
        移除
      </button>
    </figure>
  );
}

function FactoryPhotosSection({
  assetId,
  photos,
  canEdit,
  onReload,
  onNotice,
}: {
  assetId: string;
  photos: FactoryPhoto[];
  canEdit: boolean;
  onReload: () => void;
  onNotice: (notice: Notice) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const addFiles = (files: FileList | null) => {
    const next = Array.from(files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!next.length) return;
    setPending((current) => [...current, ...next]);
    onNotice(null);
  };
  const upload = async () => {
    if (!pending.length)
      return onNotice({ tone: "error", text: "请先选择或拍摄出厂照片。" });
    setUploading(true);
    setProgress({ done: 0, total: pending.length });
    let success = 0;
    const failures: string[] = [];
    for (let index = 0; index < pending.length; index += 1) {
      const file = pending[index];
      const body = new FormData();
      body.append("files", file);
      try {
        await api(`/admin/assets/${assetId}/factory-photos`, {
          method: "POST",
          body,
        });
        success += 1;
      } catch (error) {
        failures.push(
          `${file.name || `第 ${index + 1} 张`}: ${errorText(error)}`,
        );
      }
      setProgress({ done: index + 1, total: pending.length });
    }
    setUploading(false);
    if (success > 0) {
      setPending([]);
      onReload();
    }
    onNotice(
      failures.length
        ? {
            tone: "error",
            text: success
              ? `已上传 ${success} 张，${failures.length} 张失败：${failures[0]}`
              : failures[0] || "上传失败。",
          }
        : { tone: "success", text: `已上传 ${success} 张出厂照片。` },
    );
  };
  const viewer = viewerIndex === null ? null : (photos[viewerIndex] ?? null);
  return (
    <DetailSection title={`出厂照片（${photos.length}）`}>
      <p className="hint">
        出厂照片为内部资料，不会通过官网或 Public Warranty API
        返回。管理员可批量拍照/上传，其他授权角色只读。
      </p>
      {canEdit && (
        <div className="factory-photo-uploader">
          <input
            ref={inputRef}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp,image/*"
            multiple
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="button"
            onClick={() => inputRef.current?.click()}
          >
            + 拍照 / 上传照片
          </button>
          {pending.length > 0 && (
            <button
              type="button"
              className="button button--secondary"
              disabled={uploading}
              onClick={() => void upload()}
            >
              {uploading
                ? `正在上传 ${progress.done}/${progress.total}`
                : `提交 ${pending.length} 张照片`}
            </button>
          )}
        </div>
      )}
      {pending.length > 0 && (
        <div className="factory-photo-grid factory-photo-grid--pending">
          {pending.map((file, index) => (
            <PendingFactoryPhoto
              key={`${file.name}-${file.lastModified}-${index}`}
              file={file}
              onRemove={() =>
                setPending((current) =>
                  current.filter((_, itemIndex) => itemIndex !== index),
                )
              }
            />
          ))}
        </div>
      )}
      {photos.length ? (
        <div className="factory-photo-grid">
          {photos.map((photo, index) => (
            <figure className="factory-photo-card" key={photo.id}>
              <button
                type="button"
                className="factory-photo-thumb"
                onClick={() => setViewerIndex(index)}
              >
                <img
                  src={`/api${photo.contentUrl}`}
                  alt={`${photo.originalFilename || "出厂照片"} 缩略图`}
                />
              </button>
              <figcaption>
                <strong>{photo.originalFilename || "出厂照片"}</strong>
                <span>{date(photo.uploadedAt)}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p>暂无出厂照片。</p>
      )}
      {viewer && (
        <div
          className="service-photo-viewer"
          role="dialog"
          aria-modal="true"
          onClick={() => setViewerIndex(null)}
        >
          <div
            className="service-photo-viewer__dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <button
                type="button"
                className="table-action"
                disabled={viewerIndex === 0}
                onClick={() =>
                  setViewerIndex((current) =>
                    current === null ? current : Math.max(0, current - 1),
                  )
                }
              >
                上一张
              </button>
              <strong>
                {viewer.originalFilename || "出厂照片"} ·{" "}
                {date(viewer.uploadedAt)}
              </strong>
              <button
                type="button"
                onClick={() => setViewerIndex(null)}
                aria-label="关闭图片预览"
              >
                ×
              </button>
            </header>
            <img
              src={`/api${viewer.contentUrl}`}
              alt={`${viewer.originalFilename || "出厂照片"} 大图预览`}
            />
            <div className="factory-photo-viewer-actions">
              <button
                type="button"
                className="button button--secondary"
                disabled={viewerIndex === photos.length - 1}
                onClick={() =>
                  setViewerIndex((current) =>
                    current === null
                      ? current
                      : Math.min(photos.length - 1, current + 1),
                  )
                }
              >
                下一张
              </button>
              {canEdit && (
                <button
                  type="button"
                  className="button button--secondary table-action--danger"
                  onClick={() =>
                    void api(
                      `/admin/assets/${assetId}/factory-photos/${viewer.id}`,
                      { method: "DELETE" },
                    )
                      .then(() => {
                        setViewerIndex(null);
                        onReload();
                        onNotice({ tone: "success", text: "出厂照片已删除。" });
                      })
                      .catch((error) =>
                        onNotice({ tone: "error", text: errorText(error) }),
                      )
                  }
                >
                  删除照片
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </DetailSection>
  );
}

function AssetDetailPage({
  user,
  route,
  logout,
  assetId,
}: Props & { assetId: string }) {
  const base = assetBase(route);
  const [data, setData] = useState<AssetDetail | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState(false);
  const [photoViewer, setPhotoViewer] = useState<AssetPhoto | null>(null);
  const canEdit = user.permissions.includes("asset:manage");
  const load = useCallback(() => {
    void api<AssetDetail>(`/assets/${assetId}`)
      .then(setData)
      .catch((error) => setNotice({ tone: "error", text: errorText(error) }));
  }, [assetId]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Shell
      user={user}
      route={route}
      title="资产详情"
      subtitle={
        data?.asset.currentSn || data?.asset.originalSn || "正在加载资产"
      }
      logout={logout}
    >
      <GsxTabs
        route={route}
        active=""
        canImport={user.permissions.includes("asset:import")}
      />
      <Notice notice={notice} />
      {photoViewer && (
        <div className="service-photo-viewer" role="dialog" aria-modal="true">
          <div className="service-photo-viewer__dialog">
            <header>
              <strong>
                {photoCategoryName[photoViewer.category] ??
                  photoViewer.category}
              </strong>
              <button
                type="button"
                onClick={() => setPhotoViewer(null)}
                aria-label="关闭图片预览"
              >
                ×
              </button>
            </header>
            <img
              src={photoViewer.dataUrl}
              alt={`${photoCategoryName[photoViewer.category] ?? photoViewer.category} 大图预览`}
            />
          </div>
        </div>
      )}
      {!data ? (
        <p>正在加载…</p>
      ) : (
        <>
          <p className="breadcrumb">
            <a href={`#${base}/list`}>资产列表</a> /{" "}
            {data.asset.currentSn || data.asset.originalSn || "历史资产"}
          </p>
          <section className="panel gsx-asset-head">
            <div>
              <Pill value={data.asset.warrantyStatus} />
              <h2>
                {data.asset.productName} {data.asset.version || ""}
              </h2>
              <p>当前 SN：{data.asset.currentSn || "待补充"}</p>
            </div>
            <div className="action-list">
              <Pill value={data.asset.assetStatus} />
              {canEdit && (
                <button className="button" onClick={() => setEditing(true)}>
                  编辑全部信息
                </button>
              )}
            </div>
          </section>
          <DetailSection title="资产信息">
            <DetailRows
              rows={[
                ["当前 SN", data.asset.currentSn],
                ["原始 SN", data.asset.originalSn],
                [
                  "全部历史 SN",
                  data.identifiers
                    .filter((item) =>
                      ["legacy_sn", "replacement_sn", "original_sn"].includes(
                        item.identifierType,
                      ),
                    )
                    .map((item) => item.identifierValue)
                    .join("、"),
                ],
                [
                  "历史标识",
                  data.identifiers
                    .filter(
                      (item) =>
                        ![
                          "current_sn",
                          "original_sn",
                          "legacy_sn",
                          "replacement_sn",
                        ].includes(item.identifierType),
                    )
                    .map((item) => item.identifierValue)
                    .join("、"),
                ],
                ["产品名称", data.asset.productName],
                ["产品版本", data.asset.version],
                ["SKU", data.asset.sku],
                ["物料编码", data.asset.materialCode],
                ["资产状态", <Pill value={data.asset.assetStatus} />],
                ["创建时间", date(data.asset.createdAt)],
                ["最后更新时间", date(data.asset.updatedAt)],
              ]}
            />
          </DetailSection>
          <DetailSection title="保修信息">
            <DetailRows
              rows={[
                ["保修状态", <Pill value={data.asset.warrantyStatus} />],
                [
                  "发货日期",
                  data.sales[0]?.purchaseDate
                    ? date(data.sales[0].purchaseDate)
                    : "—",
                ],
                ["保修开始日期", date(data.asset.warrantyStartAt)],
                ["保修结束日期", date(data.asset.warrantyEndAt)],
                [
                  "保修期限天数",
                  data.asset.warrantyDays
                    ? `${data.asset.warrantyDays} 天`
                    : "待确认",
                ],
                [
                  "保修规则来源",
                  data.asset.sku ? `${data.asset.sku} 产品规则` : "历史导入",
                ],
                [
                  "是否人工覆盖",
                  data.asset.warrantyOverrideStatus ? "是" : "否",
                ],
                ["人工覆盖原因", data.asset.warrantyOverrideReason],
                ["最后修改人", data.asset.updatedByName],
                ["最后修改时间", date(data.asset.updatedAt)],
              ]}
            />
          </DetailSection>
          <DetailSection title="公开保修">
            <p className="hint">
              官网展示数据。这里修改只影响 maxcine.cn 公开查询，不会修改内部 GSX
              保修。
            </p>
            {canEdit ? (
              <PublicWarrantyEditor
                asset={data.asset}
                publicWarranty={data.publicWarranty}
                onSaved={load}
              />
            ) : (
              <DetailRows
                rows={[
                  [
                    "公开查询",
                    data.publicWarranty?.isPublicQueryEnabled
                      ? "允许"
                      : "不允许",
                  ],
                  [
                    "官网展示状态",
                    data.publicWarranty?.warrantyStatus || "未初始化",
                  ],
                  [
                    "公开保修开始",
                    date(data.publicWarranty?.publicWarrantyStartDate),
                  ],
                  [
                    "公开保修结束",
                    date(data.publicWarranty?.publicWarrantyEndDate),
                  ],
                  ["公开备注", data.publicWarranty?.publicNote],
                ]}
              />
            )}
          </DetailSection>
          <FactoryPhotosSection
            assetId={data.asset.id}
            photos={data.factoryPhotos}
            canEdit={canEdit}
            onReload={load}
            onNotice={setNotice}
          />
          <DetailSection title="销售与订单">
            <DetailRows
              rows={[
                ["订单号", data.asset.latestOrderNo],
                ["经销商", data.asset.dealerName],
                ["店铺", data.asset.storeName],
                [
                  "售卖金额",
                  data.asset.salePriceCents === null
                    ? "—"
                    : `¥${((data.asset.salePriceCents ?? 0) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2 })}`,
                ],
                ["用户画像", data.asset.customerProfile],
                ["收货信息", data.asset.shippingAddress],
                ["订单状态", data.asset.orderStatus],
                [
                  "审核记录",
                  data.audit.find((item) => item.action.includes("order."))
                    ?.action || "—",
                ],
              ]}
            />
            {data.asset.screenshotDataUrl && (
              <div className="order-screenshot-preview">
                <span>订单截图</span>
                <img src={data.asset.screenshotDataUrl} alt="订单截图" />
              </div>
            )}
          </DetailSection>
          <DetailSection title="物流信息">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>销售渠道</th>
                    <th>购买日期</th>
                    <th>运单号</th>
                    <th>发货仓库</th>
                    {user.permissions.includes("data:read:all") && (
                      <th>原始价格记录</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.sales.map((sale, index) => (
                    <tr key={index}>
                      <td>{sale.sourceChannel || "—"}</td>
                      <td>{date(sale.purchaseDate)}</td>
                      <td>{sale.trackingNumber || "—"}</td>
                      <td>{sale.shippingWarehouse || "—"}</td>
                      {user.permissions.includes("data:read:all") && (
                        <td>{sale.purchasePriceRaw || "—"}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.sales.length && <p>暂无物流记录。</p>}
            </div>
          </DetailSection>
          <DetailSection title="相关照片">
            <div className="asset-photo-grid">
              {data.photos
                .filter((photo) => photo.dataUrl)
                .map((photo) => (
                  <figure
                    className="asset-photo-card"
                    key={`${photo.source}-${photo.id}`}
                  >
                    <img
                      src={photo.dataUrl}
                      alt={photoCategoryName[photo.category] ?? photo.category}
                    />
                    <figcaption>
                      <strong>
                        {photoCategoryName[photo.category] ?? photo.category}
                      </strong>
                      <span>
                        {photo.source === "shipment" ? "仓库出库" : "售后工单"}{" "}
                        · {photo.relatedNo || "—"} · {date(photo.createdAt)}
                      </span>
                    </figcaption>
                    <button
                      type="button"
                      className="table-action"
                      onClick={() => setPhotoViewer(photo)}
                    >
                      查看
                    </button>
                  </figure>
                ))}
            </div>
            {!data.photos.filter((photo) => photo.dataUrl).length && (
              <p>
                暂无可查看照片。旧附件如未保存图片内容，只会在对应工单中显示文件名。
              </p>
            )}
          </DetailSection>
          <DetailSection title="售后信息">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>工单号</th>
                    <th>工单状态</th>
                    <th>服务中心</th>
                    <th>创建日期</th>
                    <th>问题描述</th>
                    <th>检测结果</th>
                    <th>最终处理结果</th>
                    <th>查看</th>
                  </tr>
                </thead>
                <tbody>
                  {data.serviceCases.map((item) => (
                    <tr key={item.id}>
                      <td>{item.caseNo}</td>
                      <td>{item.status}</td>
                      <td>{item.serviceCenterName || "—"}</td>
                      <td>{date(item.createdAt)}</td>
                      <td>{item.description || item.subject}</td>
                      <td>
                        {item.inspectionResult || item.recommendation || "—"}
                      </td>
                      <td>{item.finalResult || "—"}</td>
                      <td>
                        <a
                          href={`#${route.startsWith("/system/service-center") ? "/system/service-center/cases/" : "/system/admin/after-sales/"}${item.id}`}
                        >
                          查看
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.serviceCases.length && <p>暂无关联售后工单。</p>}
            </div>
          </DetailSection>
          <DetailSection title="生命周期">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>事件类型</th>
                    <th>操作人</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((event) => (
                    <tr key={event.id}>
                      <td>{date(event.occurredAt || event.createdAt)}</td>
                      <td>{event.eventType}</td>
                      <td>{event.operatorName || "系统"}</td>
                      <td>
                        {event.title}
                        {event.description ? `：${event.description}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.events.length && <p>暂无生命周期记录。</p>}
            </div>
          </DetailSection>
          <DetailSection title="备注">
            {data.notes.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>备注内容</th>
                      <th>来源</th>
                      <th>创建时间</th>
                      <th>最后修改时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.notes.map((note, index) => (
                      <tr key={index}>
                        <td>{note.content}</td>
                        <td>{note.source || note.category}</td>
                        <td>{date(note.createdAt)}</td>
                        <td>{date(note.updatedAt || note.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>当前账户无可查看备注。</p>
            )}
          </DetailSection>
          <DetailSection title="审计记录">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>操作</th>
                    <th>操作人</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {data.audit.map((item, index) => (
                    <tr key={index}>
                      <td>{item.action}</td>
                      <td>{item.actorName || "系统"}</td>
                      <td>{date(item.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.audit.length && <p>暂无可查看审计记录。</p>}
            </div>
          </DetailSection>
          {editing && (
            <AssetEditModal
              data={data}
              onClose={() => setEditing(false)}
              onSaved={load}
            />
          )}
        </>
      )}
    </Shell>
  );
}

export function GsxPortal(props: Props) {
  const path = props.route.split("?")[0];
  const base = assetBase(props.route);
  if (path === `${base}/import`) return <ImportPage {...props} />;
  if (path === `${base}/list`) return <AssetList {...props} />;
  if (path === `${base}/warranty`)
    return <AssetList {...props} mode="warranty" />;
  if (path === `${base}/exceptions`)
    return <AssetList {...props} mode="exceptions" />;
  if (path.startsWith(`${base}/`))
    return <AssetDetailPage {...props} assetId={path.split("/").at(-1)!} />;
  return <SearchHome {...props} />;
}
