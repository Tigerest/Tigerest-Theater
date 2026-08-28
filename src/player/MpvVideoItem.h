#ifndef MPVVIDEOITEM_H
#define MPVVIDEOITEM_H

#include <MpvAbstractItem>
#include <QPointF>
#include <Qt>

class PlayerComponent;
class QHoverEvent;
class QKeyEvent;
class QMouseEvent;
class QEvent;
class QWindow;
class QWheelEvent;

class MpvVideoItem : public MpvAbstractItem
{
    Q_OBJECT
    QML_ELEMENT

public:
    explicit MpvVideoItem(QQuickItem *parent = nullptr);
    void setPlayerComponent(PlayerComponent* player);
    bool usingNativeGpuNext() const { return m_nativeGpuNext; }

    MpvController* controller() { return mpvController(); }

Q_SIGNALS:
    void fullscreenRequested(bool fullscreen);

protected:
    bool eventFilter(QObject* watched, QEvent* event) override;
    void hoverEnterEvent(QHoverEvent* event) override;
    void hoverMoveEvent(QHoverEvent* event) override;
    void hoverLeaveEvent(QHoverEvent* event) override;
    void mouseMoveEvent(QMouseEvent* event) override;
    void mousePressEvent(QMouseEvent* event) override;
    void mouseReleaseEvent(QMouseEvent* event) override;
    void mouseDoubleClickEvent(QMouseEvent* event) override;
    void wheelEvent(QWheelEvent* event) override;
    void keyPressEvent(QKeyEvent* event) override;
    void keyReleaseEvent(QKeyEvent* event) override;

private:
    void initializeController();
    QWindow* ensureNativeHostWindow();
    void updateNativeHostWindow();
    void sendMousePosition(const QPointF& position);
    QString mouseButtonName(Qt::MouseButton button) const;
    QString keyName(QKeyEvent* event) const;

    PlayerComponent* m_player = nullptr;
    bool m_escapeHandledLocally = false;
    bool m_spaceHandledLocally = false;
    bool m_fullscreenHandledLocally = false;
    bool m_statsHandledLocally = false;
    bool m_profileHandledLocally = false;
    bool m_nativeGpuNext = false;
    QWindow* m_nativeHostWindow = nullptr;
    MpvController* m_initializedController = nullptr;
};

#endif // MPVVIDEOITEM_H
