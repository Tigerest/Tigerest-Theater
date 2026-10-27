#ifndef VERSION_H
#define VERSION_H

namespace Version
{
  QString GetVersionString();
  QString GetCanonicalVersionString();
  QString GetBuildDate();
  // Short commit hash of the build, empty when built outside a Git checkout.
  QString GetBuildRevision();
  QString GetWebVersion();
  QString GetQtDepsVersion();
  QString GetDependenciesVersion();
};

#endif // VERSION_H

