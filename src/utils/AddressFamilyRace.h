#pragma once
#include <QNetworkRequest>

// A host name can resolve to an IPv6 address that never answers, for example a
// home server whose AAAA record is stale. Qt opens one socket for an HTTP/2
// request and tries the addresses in turn, so that address holds the request
// for the 30-second connect timeout before IPv4 is tried. For HTTP/1.1 it
// starts both address families 300 ms apart and keeps the first to connect.
inline void raceAddressFamilies(QNetworkRequest& request)
{
  request.setAttribute(QNetworkRequest::Http2AllowedAttribute, false);
}
