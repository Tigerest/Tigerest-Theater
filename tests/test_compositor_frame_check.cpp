#include <QtTest>
#include "compositor_frame_check.h"

class CompositorFrameCheckTest : public QObject {
  Q_OBJECT
private slots:
  void rejectsCorruptPixels() {
    QImage frame(100, 100, QImage::Format_RGB32);
    frame.fill(Qt::red);
    const QVector<CompositorSample> samples{{"poster", QRect(10, 10, 60, 60), Qt::red}};
    QVERIFY(checkCompositorFrame(frame, samples).isEmpty());
    // A diagonal/stale block only has to damage one checked pixel to fail.
    frame.setPixelColor(43, 48, Qt::black);
    QVERIFY(!checkCompositorFrame(frame, samples).isEmpty());
  }
  void rejectsMissingEvidence() {
    QImage frame(100, 100, QImage::Format_RGB32);
    frame.fill(Qt::red);
    QVERIFY(!checkCompositorFrame(frame, {}).isEmpty());
    QVERIFY(!checkCompositorFrame({}, {{"poster", QRect(10, 10, 5, 5), Qt::red}}).isEmpty());
    QVERIFY(!checkCompositorFrame(frame, {{"poster", QRect(95, 95, 20, 20), Qt::red}}).isEmpty());
  }
  void toleratesDisplayRounding() {
    QImage frame(100, 100, QImage::Format_RGB32);
    frame.fill(QColor(250, 3, 4));
    QVERIFY(checkCompositorFrame(frame, {{"poster", QRect(10, 10, 60, 60), Qt::red}}).isEmpty());
  }
};
QTEST_APPLESS_MAIN(CompositorFrameCheckTest)
#include "test_compositor_frame_check.moc"
