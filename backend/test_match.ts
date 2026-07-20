function matchPath(
  requestPath: string,
  pattern: string,
): Record<string, string> | null {
  const reqParts = requestPath.replace(/\/+$/, '').split('/');
  const patParts = pattern.replace(/\/+$/, '').split('/');

  if (reqParts.length !== patParts.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (let i = 0; i < patParts.length; i++) {
    const pat = patParts[i]!;
    const req = reqParts[i]!;

    if (pat.startsWith(':')) {
      params[pat.slice(1)] = decodeURIComponent(req);
    } else if (pat !== req) {
      return null;
    }
  }

  return params;
}

console.log(matchPath('/api/options/insights/BMNR', '/api/options/insights/:symbol'));
