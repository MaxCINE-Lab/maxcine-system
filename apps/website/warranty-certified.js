// Additive rendering for Certified projection fields; no new query or visual shell.
export function renderCertifiedWarranty(response, locale = document.documentElement.lang) {
  const anchor = document.getElementById('sn');
  if (!anchor) return;
  document.getElementById('certified-warranty-details')?.remove();
  if (!response.assetCode) return;
  const english = locale === 'en' || locale?.startsWith('en-');
  const details = document.createElement('div');
  details.id = 'certified-warranty-details';
  const fields = [
    ['Asset', response.assetCode],
    [english ? 'Coverage' : '保修范围', english ? 'MaxCINE Certified 12-Month Limited Warranty' : response.warrantyPolicyName],
    [english ? 'Market' : '服务地区', response.marketRegion],
    [english ? 'Certification' : '认证状态', response.certificationStatus],
    ['Grade', response.grade]
  ];
  for (const [label, value] of fields) {
    if (!value) continue;
    const line = document.createElement('p');
    line.textContent = `${label}: ${value}`;
    details.append(line);
  }
  anchor.after(details);
}
