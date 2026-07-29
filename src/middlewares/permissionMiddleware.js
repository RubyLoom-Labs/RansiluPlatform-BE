const MODULE_ALIASES = {
  songs: 'songs',
  song: 'songs',
  artists: 'artists',
  artist: 'artists',
  albums: 'albums',
  album: 'albums',
  ringtones: 'ringtones',
  ringtone: 'ringtones',
  ringintone: 'ringtones',
  'record-label': 'record_labels',
  'record-labels': 'record_labels',
  'recode-labels': 'record_labels',
  'recordlabel': 'record_labels',
  'recordlabels': 'record_labels',
  distributor: 'distributor',
  distributors: 'distributor',
  revenue: 'revenue',
  calendar: 'calendar',
  'e-accounts': 'eaccounts',
  'eaccounts': 'eaccounts',
  e_account: 'eaccounts',
  ownership: 'ownership',
  ownerships: 'ownership',
  'notes-and-cases': 'notes_cases',
  'notes-cases': 'notes_cases',
  notesandcases: 'notes_cases',
  settings: 'settings',
};

const NORMALIZED_MODULE_ALIASES = Object.fromEntries(
  Object.entries(MODULE_ALIASES).map(([key, value]) => [normalizeAliasKey(key), value])
);

function normalizeAliasKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/[_\s&-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function normalizeModule(moduleName) {
  if (!moduleName) return '';

  const cleaned = normalizeAliasKey(moduleName);
  return NORMALIZED_MODULE_ALIASES[cleaned] || cleaned;
}

function normalizeAction(action) {
  if (!action) return '';

  const normalized = String(action).toLowerCase();
  if (normalized === 'view' || normalized === 'read') return 'view';
  if (normalized === 'update' || normalized === 'edit') return 'edit';
  if (normalized === 'create' || normalized === 'post') return 'create';
  if (normalized === 'delete' || normalized === 'remove') return 'delete';
  if (normalized === 'export') return 'export';
  return normalized;
}

function matchPermission(permissionEntry, moduleName, action) {
  const requestedModule = normalizeModule(moduleName);
  const requestedAction = normalizeAction(action);

  if (!requestedModule || !requestedAction) {
    return false;
  }

  const permissionName = String(permissionEntry?.permission_name || '').trim().toLowerCase();
  if (permissionName) {
    const [permModule, permAction] = permissionName.split(':');
    if (normalizeModule(permModule) === requestedModule && normalizeAction(permAction) === requestedAction) {
      return true;
    }
  }

  const permissionTab = normalizeModule(permissionEntry?.tab_name || '');
  const permissionAction = normalizeAction(permissionEntry?.action || '');

  return Boolean(permissionTab && permissionAction && permissionTab === requestedModule && permissionAction === requestedAction);
}

function inferModule(req) {
  const baseUrl = req.baseUrl || req.originalUrl || req.url || '';
  const segments = String(baseUrl)
    .split('/')
    .filter(Boolean)
    .filter((segment) => segment !== 'api');

  if (segments.length === 0) {
    return '';
  }

  return normalizeModule(segments[0]);
}

function inferAction(req) {
  const path = String(req.path || '').toLowerCase();

  if (path.includes('/export')) {
    return 'export';
  }

  switch (req.method) {
    case 'POST':
      return 'create';
    case 'PUT':
    case 'PATCH':
      return 'edit';
    case 'DELETE':
      return 'delete';
    case 'GET':
    default:
      return 'view';
  }
}

function requireRoutePermission(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const requiredModule = inferModule(req);
  const requiredAction = inferAction(req);
  const permissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];

  const hasAccess = permissions.some((permission) => matchPermission(permission, requiredModule, requiredAction));

  if (!hasAccess) {
    return res.status(401).json({ message: `You do not have permission to access this ${requiredModule || 'resource'}.` });
  }

  return next();
}

module.exports = {
  requireRoutePermission,
  matchPermission,
  inferModule,
  inferAction,
};
