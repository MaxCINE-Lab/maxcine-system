import { one } from './db';

// Read-only projection of canonical Asset / location / RMA facts. Sellable reuses
// the ordinary inventory predicate: not QUARANTINED, WAREHOUSE on_hand, not in
// service, no open RMA and no active transfer.
export async function operationalState(db:D1Database,rmaId:string){
  const s=await one<{inventoryStatus:string;custody:string|null;locationStatus:string|null;warehouseCode:string|null;warehouseMarket:string|null;locationCode:string|null;rmaStatus:string;rmaStage:string;sellable:number}>(db,
   `SELECT a.inventory_status AS inventoryStatus,l.custody,l.status AS locationStatus,w.code AS warehouseCode,w.market_region AS warehouseMarket,area.code AS locationCode,
    c.status AS rmaStatus,c.service_stage AS rmaStage,
    CASE WHEN a.inventory_status<>'QUARANTINED' AND l.custody='WAREHOUSE' AND l.status='on_hand' AND a.asset_status<>'in_service'
     AND NOT EXISTS(SELECT 1 FROM after_sales_cases r WHERE r.asset_id=a.id AND r.status IN ('open','in_progress'))
     AND NOT EXISTS(SELECT 1 FROM asset_transfers t WHERE t.asset_id=a.id AND t.status IN ('created','shipped')) THEN 1 ELSE 0 END AS sellable
    FROM after_sales_cases c JOIN assets a ON a.id=c.asset_id LEFT JOIN asset_locations l ON l.asset_id=a.id
    LEFT JOIN warehouses w ON w.id=l.warehouse_id LEFT JOIN warehouse_locations area ON area.id=l.location_id WHERE c.id=?`,rmaId);
  if(!s)return null;
  return {...s,warehouseCode:s.custody==='WAREHOUSE'?s.warehouseCode:null,sellable:s.sellable===1,
    inventoryReleasePending:s.inventoryStatus==='QUARANTINED',rmaOpen:['open','in_progress'].includes(s.rmaStatus)};
}
