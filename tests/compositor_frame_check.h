#pragma once
#include <QImage>
#include <QRect>
#include <QStringList>
#include <QVector>

struct CompositorSample {
  QString name;
  QRect rect;
  QColor color;
};

inline QStringList checkCompositorFrame(const QImage &frame, const QVector<CompositorSample> &samples)
{
  QStringList errors;
  if (frame.isNull() || samples.isEmpty())
    return {"Missing actual frame or pixel samples"};
  for (const auto &sample : samples) {
    if (sample.rect.isEmpty() || !frame.rect().contains(sample.rect)) {
      errors.append(sample.name + ": sample outside captured client area");
      continue;
    }
    bool damaged = false;
    for (int y = sample.rect.top(); y <= sample.rect.bottom() && !damaged; ++y) {
      for (int x = sample.rect.left(); x <= sample.rect.right(); ++x) {
        const QColor pixel = frame.pixelColor(x, y);
        if (qAbs(pixel.red() - sample.color.red()) > 8 ||
            qAbs(pixel.green() - sample.color.green()) > 8 ||
            qAbs(pixel.blue() - sample.color.blue()) > 8) {
          errors.append(QString("%1: pixel (%2,%3) was %4, expected %5")
                            .arg(sample.name).arg(x).arg(y).arg(pixel.name(), sample.color.name()));
          damaged = true;
          break;
        }
      }
    }
  }
  return errors;
}
